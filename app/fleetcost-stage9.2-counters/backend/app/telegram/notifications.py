"""
Telegram notification sender.
Sends per-transaction alerts and summary reports to company owners.
"""
import logging
from typing import Optional
from sqlalchemy import select
from app.core.database import AsyncSessionLocal
from app.core.config import settings
from app.models.models import TelegramSettings, Transaction

logger = logging.getLogger(__name__)


def _get_bot():
    """Lazy-load aiogram bot to avoid import errors if token not set."""
    if not settings.TELEGRAM_BOT_TOKEN:
        return None
    try:
        from aiogram import Bot
        return Bot(token=settings.TELEGRAM_BOT_TOKEN)
    except Exception as e:
        logger.warning(f"Failed to init Telegram bot: {e}")
        return None


CATEGORY_EMOJI = {
    "fuel": "⛽",
    "toll": "🛣️",
    "service": "🔧",
}

COUNTRY_FLAGS = {
    "PL": "🇵🇱",
    "DE": "🇩🇪",
    "BE": "🇧🇪",
    "FR": "🇫🇷",
    "NL": "🇳🇱",
    "CZ": "🇨🇿",
    "AT": "🇦🇹",
    "HU": "🇭🇺",
    "SK": "🇸🇰",
}


def _format_transaction_message(txn: Transaction) -> str:
    flag = COUNTRY_FLAGS.get(txn.country or "", "🌍")
    ftype = txn.fuel_type or "—"
    amount_str = f"{txn.amount:.2f} {txn.currency}"
    date_str = txn.transaction_date.strftime("%d.%m.%Y %H:%M") if txn.transaction_date else "—"
    plate = txn.plate_number or "—"
    driver = txn.driver_name or ""
    driver_str = f" ({driver})" if driver else ""
    address = txn.station_address or ""
    address_str = f"\n📍 {address}" if address else ""

    return (
        f"💳 <b>Новая транзакция</b>\n"
        f"🚛 <b>{plate}</b>{driver_str}\n"
        f"{flag} {ftype}\n"
        f"💰 <b>{amount_str}</b>\n"
        f"📅 {date_str}"
        f"{address_str}"
    )


async def send_new_transaction_notification(
    company_id: int,
    txn: Transaction,
):
    """Send a per-transaction Telegram notification to the company owner."""
    async with AsyncSessionLocal() as db:
        result = await db.execute(
            select(TelegramSettings).where(
                TelegramSettings.company_id == company_id,
                TelegramSettings.is_active == True,
                TelegramSettings.notify_on_transaction == True,
            )
        )
        tg_settings = result.scalar_one_or_none()

    if not tg_settings or not tg_settings.chat_id:
        return

    bot = _get_bot()
    if not bot:
        return

    try:
        message = _format_transaction_message(txn)
        await bot.send_message(
            chat_id=tg_settings.chat_id,
            text=message,
            parse_mode="HTML",
        )
    except Exception as e:
        logger.warning(f"Failed to send Telegram notification: {e}")
    finally:
        await bot.session.close()


async def send_daily_summary(company_id: int, summary: dict):
    """Send daily summary to company owner."""
    async with AsyncSessionLocal() as db:
        result = await db.execute(
            select(TelegramSettings).where(
                TelegramSettings.company_id == company_id,
                TelegramSettings.is_active == True,
                TelegramSettings.notify_daily_summary == True,
            )
        )
        tg_settings = result.scalar_one_or_none()

    if not tg_settings or not tg_settings.chat_id:
        return

    bot = _get_bot()
    if not bot:
        return

    try:
        lines = [f"📊 <b>Сводка за сегодня</b>"]
        for plate, data in summary.get("by_vehicle", {}).items():
            lines.append(f"🚛 {plate}: {data['total']:.2f} EUR ({data['count']} транз.)")
        lines.append(f"\n💰 <b>Итого: {summary.get('total', 0):.2f} EUR</b>")

        await bot.send_message(
            chat_id=tg_settings.chat_id,
            text="\n".join(lines),
            parse_mode="HTML",
        )
    except Exception as e:
        logger.warning(f"Failed to send daily summary: {e}")
    finally:
        await bot.session.close()
