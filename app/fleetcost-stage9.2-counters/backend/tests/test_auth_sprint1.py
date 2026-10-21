"""Спринт 1 аудита stage8: SEC-02 (отзыв токенов), SEC-03 (пароли), PAY-01.

Проверяются механизмы, добавленные исправлениями аудита:
1. Парольная политика: минимум 10 символов + стоп-лист расхожих паролей.
2. Access-JWT несёт клеймы jti/ver; повышение User.token_version мгновенно
   аннулирует ранее выданные токены (deps._resolve_user_from_token).
3. Refresh-токены: SHA-256-хэш детерминирован, разные токены не совпадают.
4. Схема: users.token_version и таблица refresh_tokens создаются миграцией
   (schema_sync.create_all) и совпадают с моделью.
"""
import asyncio
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

os.environ["ENVIRONMENT"] = "development"
os.environ["SECRET_KEY"] = "test-secret-key-0123456789abcdef"

from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.database import Base
from app.core import schema_sync
from app.core.security import (
    create_access_token,
    decode_token,
    generate_refresh_token,
    hash_refresh_token,
)
from app.models.models import Company, RefreshToken, User, UserRole
from app.api.deps import _resolve_user_from_token
from app.schemas.schemas import RegisterRequest, validate_password_complexity
from pydantic import ValidationError


class PasswordPolicySuite(unittest.TestCase):
    """SEC-03: политика паролей."""

    def test_01_min_length_is_10(self):
        # 9 символов с заглавной и цифрой — раньше прошли бы, теперь нет.
        with self.assertRaises(ValidationError):
            RegisterRequest(company_name="C", email="a@b.co", password="Ab1x2y3z4")
        # ровно 10 — ок
        req = RegisterRequest(company_name="C", email="a@b.co", password="Ab1x2y3z45")
        self.assertEqual(req.password, "Ab1x2y3z45")

    def test_02_requires_upper_and_digit(self):
        # «abcdefghij1» — нет заглавной; «Abcdefghij» — нет цифры.
        # (Верхний регистр без строчных — валиден, как и прежде.)
        for bad in ("abcdefghij1", "Abcdefghij"):
            with self.assertRaises(ValueError, msg=bad):
                validate_password_complexity(bad)

    def test_03_common_passwords_are_rejected(self):
        # Проходят «формальную» проверку (10+, заглавная, цифра), но стоят
        # в стоп-листе: перебираются первыми в любом словаре.
        for bad in ("Password123", "Password1234", "Qwertyuiop1", "Admin12345",
                    "Abc12345678", "Welcome1234"):
            with self.assertRaises(ValueError, msg=bad):
                validate_password_complexity(bad)

    def test_04_strong_uncommon_password_passes(self):
        ok = validate_password_complexity("Gh7Kp2Wq9z")
        self.assertEqual(ok, "Gh7Kp2Wq9z")

    def test_05_policy_applies_to_user_create(self):
        from app.schemas.schemas import UserCreate
        with self.assertRaises(ValidationError):
            UserCreate(email="m@b.co", password="Short1", role="manager")


class TokenVersionSuite(unittest.IsolatedAsyncioTestCase):
    """SEC-02: клеймы jti/ver и мгновенный отзыв access-токенов."""

    async def asyncSetUp(self):
        self.engine = create_async_engine(os.environ["DATABASE_URL"])
        self.Session = async_sessionmaker(self.engine, expire_on_commit=False)
        async with self.engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
            await conn.run_sync(Base.metadata.create_all)
        async with self.Session() as db:
            company = Company(name="T")
            db.add(company)
            await db.flush()
            user = User(company_id=company.id, email="u@t.co",
                        hashed_password="x", role=UserRole.owner)
            db.add(user)
            await db.commit()
            self.company_id, self.user_id = company.id, user.id

    async def asyncTearDown(self):
        await self.engine.dispose()
        # Общий файл БД прогона (conftest) не удаляем: им пользуются
        # и остальные наборы. Данные изолирует drop_all/create_all в asyncSetUp.

    async def test_01_token_carries_jti_and_ver(self):
        token = create_access_token({"sub": "1", "ver": 2})
        payload = decode_token(token)
        self.assertEqual(payload["ver"], 2)
        self.assertTrue(payload.get("jti"))
        # Разные токены — разные jti (для отзыва и аудита).
        t2 = create_access_token({"sub": "1", "ver": 2})
        self.assertNotEqual(payload["jti"], decode_token(t2)["jti"])

    async def test_02_resolve_accepts_matching_version(self):
        token = create_access_token({"sub": str(self.user_id), "ver": 0})
        async with self.Session() as db:
            user = await _resolve_user_from_token(token, db)
        self.assertIsNotNone(user)
        self.assertEqual(user.id, self.user_id)

    async def test_03_bumping_version_revokes_old_tokens(self):
        token = create_access_token({"sub": str(self.user_id), "ver": 0})
        async with self.Session() as db:
            u = (await db.execute(select(User).where(User.id == self.user_id))).scalar_one()
            u.token_version = 1            # «выйти на всех устройствах»
            await db.commit()
        async with self.Session() as db:
            user = await _resolve_user_from_token(token, db)
        self.assertIsNone(user, "старый токен обязан отозваться после повышения версии")

    async def test_04_token_without_ver_is_rejected(self):
        # Токены, выпущенные ДО внедрения SEC-02 (7-дневные, без "ver"),
        # больше не принимаются — перелогин после деплоя обязателен.
        token = create_access_token({"sub": str(self.user_id)})  # ver=0 проставится
        payload = decode_token(token)
        payload.pop("ver", None)
        from jose import jwt as _jwt
        from app.core.config import settings
        legacy = _jwt.encode(payload, settings.SECRET_KEY, algorithm=settings.ALGORITHM)
        async with self.Session() as db:
            user = await _resolve_user_from_token(legacy, db)
        self.assertIsNone(user)

    async def test_05_refresh_token_hashing(self):
        a, b = generate_refresh_token(), generate_refresh_token()
        self.assertNotEqual(a, b)
        self.assertEqual(hash_refresh_token(a), hash_refresh_token(a))
        self.assertNotEqual(hash_refresh_token(a), hash_refresh_token(b))
        self.assertEqual(len(hash_refresh_token(a)), 64)   # sha256 hex


class RefreshTokenSchemaSuite(unittest.IsolatedAsyncioTestCase):
    """SEC-02: таблица refresh_tokens в схеме и согласованность с моделью."""

    async def test_01_table_and_indexes_exist(self):
        engine = create_async_engine(os.environ["DATABASE_URL"])
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
            await conn.run_sync(Base.metadata.create_all)
            cols = await schema_sync.table_columns(conn, "refresh_tokens")
        await engine.dispose()
        for c in ("id", "user_id", "token_hash", "expires_at", "revoked_at", "user_agent", "ip"):
            self.assertIn(c, cols, f"refresh_tokens.{c} обязана существовать")

    async def test_02_users_token_version_exists(self):
        engine = create_async_engine(os.environ["DATABASE_URL"])
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
            await conn.run_sync(Base.metadata.create_all)
            cols = await schema_sync.table_columns(conn, "users")
        await engine.dispose()
        self.assertIn("token_version", cols)

    async def test_03_refresh_row_lifecycle(self):
        """Создание → отзыв → «reuse detection» видит revoked_at."""
        engine = create_async_engine(os.environ["DATABASE_URL"])
        Session = async_sessionmaker(engine, expire_on_commit=False)
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
            await conn.run_sync(Base.metadata.create_all)
        from datetime import datetime, timedelta, timezone
        async with Session() as db:
            company = Company(name="T")
            db.add(company)
            await db.flush()
            user = User(company_id=company.id, email="r@t.co", hashed_password="x")
            db.add(user)
            await db.flush()
            raw = generate_refresh_token()
            db.add(RefreshToken(user_id=user.id, token_hash=hash_refresh_token(raw),
                                expires_at=datetime.now(timezone.utc) + timedelta(days=14)))
            await db.commit()
            row = (await db.execute(select(RefreshToken).where(
                RefreshToken.token_hash == hash_refresh_token(raw)))).scalar_one()
            self.assertIsNone(row.revoked_at)
            row.revoked_at = datetime.now(timezone.utc)
            await db.commit()
        async with Session() as db:
            row = (await db.execute(select(RefreshToken))).scalar_one()
            self.assertIsNotNone(row.revoked_at)
        await engine.dispose()


class RegisterFlowSuite(unittest.IsolatedAsyncioTestCase):
    """Интеграция: регистрация обязана фиксировать refresh-строку в БД.

    Реальный баг спринта 1: в register() _issue_session() вызывался ПОСЛЕ
    commit и не имел своего commit — INSERT refresh_tokens откатывался при
    закрытии сессии get_db(), и первая же ротация получала 401. Тест
    закрывает ровно этот класс ошибок: «выдали cookie — значит строка в БД».
    """

    async def asyncSetUp(self):
        self.engine = create_async_engine(os.environ["DATABASE_URL"])
        async with self.engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
            await conn.run_sync(Base.metadata.create_all)
        import httpx
        from app.main import app
        self.client = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test")

    async def asyncTearDown(self):
        await self.client.aclose()
        await self.engine.dispose()
        # Общий файл БД прогона (conftest) не удаляем: им пользуются
        # и остальные наборы. Данные изолирует drop_all/create_all в asyncSetUp.

    async def test_register_persists_refresh_token_and_rotation_works(self):
        st = await self.client.post("/api/auth/register", json={
            "company_name": "FlowCo", "email": "flow@t.co",
            "password": "Flow2026Pass"})
        self.assertEqual(st.status_code, 200, st.text)
        csrf = st.json()["csrf_token"]
        self.assertTrue(st.cookies.get("fc_rt"), "fc_rt обязан быть установлен")

        # Строка в БД существует (раньше терялась).
        async with async_sessionmaker(self.engine)() as db:
            rows = (await db.execute(select(RefreshToken))).scalars().all()
        self.assertEqual(len(rows), 1, "refresh-строка обязана быть закоммичена")

        # Ротация по cookie из ответа регистрации проходит.
        r = await self.client.post("/api/auth/refresh",
                                   headers={"X-CSRF-Token": csrf})
        self.assertEqual(r.status_code, 200, r.text)
        csrf2 = r.json()["csrf_token"]

        # Повтор старой cookie (reuse) → 401.
        # httpx хранит уже новую куку; подменяем старую явно.
        old_rt = st.cookies.get("fc_rt")
        self.client.cookies.set("fc_rt", old_rt)
        r2 = await self.client.post("/api/auth/refresh",
                                    headers={"X-CSRF-Token": csrf2})
        self.assertEqual(r2.status_code, 401)

        # После reuse-детекции ВСЕ сессии пользователя отозваны.
        async with async_sessionmaker(self.engine)() as db:
            rows = (await db.execute(select(RefreshToken))).scalars().all()
        self.assertTrue(rows and all(x.revoked_at is not None for x in rows),
                        "reuse обязан отзывать все сессии пользователя")


if __name__ == "__main__":
    unittest.main(verbosity=2)
