"""Общий стенд для всех тестовых модулей (починка «полного прогона»).

Почему это нужно. Каждый тестовый модуль назначает свой `DATABASE_URL` при
ИМПОРТЕ, но движок приложения (`app.core.database.engine` / `AsyncSessionLocal`)
создаётся ОДИН раз — при первом импорте. В полном прогоне pytest сначала
импортирует ВСЕ модули и только потом запускает тесты: движок фиксируется на
файле первого модуля, а env-присвоения остальных уже ни на что не влияют.
Хуже того, test_auth_sprint1 удаляет свой файл БД в teardown — все СЛЕДУЮЩИЕ
наборы падали с «sqlite3.OperationalError: attempt to write a readonly
database» (78 ошибок при 144 пройденных, при зелёных модулях по отдельности).

Фикс: до импорта любых тестовых модулей фиксируем ОДИН общий файл БД и сразу
импортируем `app.core.database` — движок создаётся на нём, и позднейшие
переопределения env в модулях перестают иметь значение. Наборы по-прежнему
полностью изолированы по ДАННЫМ: каждый в asyncSetUp делает drop_all /
create_all (последовательный запуск pytest — без параллелизма).
"""
import os
import sys

# Гарантируем, что корень бэкенда в sys.path (запуск pytest может быть из
# любого каталога; сами тестовые модули полагаются на «python -m pytest»
# из backend/, здесь это делается явно).
_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

# Тестовые секреты: приложение с дефолтными значениями лишь предупреждает,
# но лучше не зависеть от содержимого .env на машине разработчика.
os.environ.setdefault("SECRET_KEY", "test-secret-key-for-conftest-not-prod")
os.environ.setdefault("ENCRYPTION_KEY", "rZZH0ZPz7q6EJmGkF9jTx3YqZ0T1Y0YhW0K5VbIq9xk=")

# ЕДИНЫЙ файл БД на весь прогон: импорт `app.core.database` здесь фиксирует
# движок до того, как тестовые модули переопределят DATABASE_URL.
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///./_test_all.db"

import app.core.database  # noqa: F401,E402  (импорт = создание движка на файле выше)
