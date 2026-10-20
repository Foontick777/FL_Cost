FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Alembic uses a sync DB driver — asyncpg (in requirements.txt) is for the
# FastAPI app, but alembic env.py translates the async URL to a sync URL
# with psycopg2. Install psycopg2-binary so alembic can connect.
RUN pip install --no-cache-dir psycopg2-binary

COPY . .

# Приложение работает от непривилегированного пользователя: если в нём найдут
# RCE, root в контейнере даёт лишние возможности (FC-022 в аудите). Каталог
# передаём этому пользователю, чтобы миграции и alembic могли писать.
RUN useradd --create-home --shell /usr/sbin/nologin app && chown -R app:app /app
USER app

# Smart migration runner — handles pre-Alembic schema by stamping baseline
# before upgrading. Falls back to lifespan's Base.metadata.create_all on
# any failure so the app still starts even if migrations are broken.
# --proxy-headers + --forwarded-allow-ips: trust the reverse proxy's
# X-Forwarded-For / X-Real-IP so request.client.host (used by the rate limiter
# and the audit log) is the real client address, not the nginx container.
CMD ["sh", "-c", "python -m app.scripts.migrate && uvicorn app.main:app --host 0.0.0.0 --port 8000 --proxy-headers --forwarded-allow-ips=*"]
