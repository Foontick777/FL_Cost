"""
Telegram bot for quick stats lookups.
Commands:
  /start  - register chat_id, get welcome message
  /today  - today's transactions
  /week   - this week's summary
  /month  - current month's summary
  /cars   - summary by vehicle for current month
  /sync   - trigger manual e100 sync
"""
import logging
from datetime import date, timedelta

from aiogram import Bot, Dispatcher, Router, F
from aiogram.filters import Command
from aiogram.types import Message
from sqlalchemy import select, func, and_
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import AsyncSessionLocal
from app.models.models import TelegramSettings, Transaction, Vehicle, Company

logger = logging.getLogger(__name__)

router = Router()


async def get_company_by_chat_id(chat_id: str) -> int | None:
    async with AsyncSessionLocal() as db:
        result = await db.execute(
            select(TelegramSettings.company_id).where(
                TelegramSettings.chat_id == str(chat_id),
                TelegramSettings.is_active == True,
            )
        )
        row = result.scalar_one_or_none()
        return row


async def get_stats(company_id: int, date_from: date, date_to: date) -> str:
    async with AsyncSessionLocal() as db:
        result = await db.execute(
            select(
                Transaction.plate_number,
                Transaction.currency,
                func.sum(Transaction.amount).label("total"),
                func.count(Transaction.id).label("count"),
            ).where(
                and_(
                    Transaction.company_id == company_id,
                    func.date(Transaction.transaction_date) >= date_from,
                    func.date(Transaction.transaction_date) <= date_to,
                )
            ).group_by(Transaction.plate_number, Transaction.currency)
            .order_by(Transaction.plate_number)
        )
        rows = result.all()

    if not rows:
        return "Нет данных за выбранный период."

    lines = []
    totals: dict[str, float] = {}
    for plate, currency, total, count in rows:
        lines.append(f"🚛 <b>{plate}</b>: {total:.2f} {currency} ({count} тр.)")
        totals[currency] = totals.get(currency, 0) + total

    lines.append("")
    for currency, total in totals.items():
        lines.append(f"💰 <b>Итого: {total:.2f} {currency}</b>")

    return "\n".join(lines)


@router.message(Command("start"))
async def cmd_start(message: Message):
    chat_id = str(message.chat.id)
    await message.answer(
        f"👋 Добро пожаловать в <b>FleetCost</b>!\n\n"
        f"Ваш chat_id: <code>{chat_id}</code>\n\n"
        f"Скопируйте этот ID и вставьте в настройки Telegram в личном кабинете FleetCost "
        f"для получения уведомлений.\n\n"
        f"Команды:\n"
        f"/today — транзакции за сегодня\n"
        f"/week — эта неделя\n"
        f"/month — текущий месяц\n"
        f"/cars — по машинам за месяц\n"
        f"/sync — синхронизация с e100",
        parse_mode="HTML",
    )


@router.message(Command("today"))
async def cmd_today(message: Message):
    company_id = await get_company_by_chat_id(message.chat.id)
    if not company_id:
        await message.answer("❌ Ваш chat_id не привязан ни к одной компании.")
        return
    today = date.today()
    stats = await get_stats(company_id, today, today)
    await message.answer(f"📅 <b>Сегодня ({today})</b>\n\n{stats}", parse_mode="HTML")


@router.message(Command("week"))
async def cmd_week(message: Message):
    company_id = await get_company_by_chat_id(message.chat.id)
    if not company_id:
        await message.answer("❌ Ваш chat_id не привязан ни к одной компании.")
        return
    today = date.today()
    week_start = today - timedelta(days=today.weekday())
    stats = await get_stats(company_id, week_start, today)
    await message.answer(
        f"📅 <b>Эта неделя ({week_start} — {today})</b>\n\n{stats}",
        parse_mode="HTML",
    )


@router.message(Command("month"))
async def cmd_month(message: Message):
    company_id = await get_company_by_chat_id(message.chat.id)
    if not company_id:
        await message.answer("❌ Ваш chat_id не привязан ни к одной компании.")
        return
    today = date.today()
    month_start = today.replace(day=1)
    stats = await get_stats(company_id, month_start, today)
    await message.answer(
        f"📅 <b>Текущий месяц ({month_start.strftime('%B %Y')})</b>\n\n{stats}",
        parse_mode="HTML",
    )


@router.message(Command("sync"))
async def cmd_sync(message: Message):
    company_id = await get_company_by_chat_id(message.chat.id)
    if not company_id:
        await message.answer("❌ Ваш chat_id не привязан ни к одной компании.")
        return

    await message.answer("🔄 Запускаю синхронизацию с e100...")
    try:
        from app.scraper.service import sync_company
        result = await sync_company(company_id)
        new = result.get("new_transactions", 0)
        await message.answer(f"✅ Синхронизация завершена. Новых транзакций: <b>{new}</b>", parse_mode="HTML")
    except Exception as e:
        await message.answer(f"❌ Ошибка синхронизации: {e}")


async def start_bot():
    """Start the Telegram bot (polling mode)."""
    if not settings.TELEGRAM_BOT_TOKEN:
        logger.warning("TELEGRAM_BOT_TOKEN not set — bot disabled")
        return

    bot = Bot(token=settings.TELEGRAM_BOT_TOKEN)
    dp = Dispatcher()
    dp.include_router(router)

    logger.info("Starting Telegram bot...")
    await dp.start_polling(bot)
