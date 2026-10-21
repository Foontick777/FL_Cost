"""Нормализация номеров прицепов.

Прицепов нет в справочнике автомобилей — номер вводится руками. Без единой
нормализации «SW 12345», «sw-12345» и «SW12345» становились тремя разными
прицепами в карточках и отчётах.
"""
import re
from typing import Optional


def normalize_trailer_plate(raw: Optional[str]) -> Optional[str]:
    """Верхний регистр, без пробелов, дефисов, точек и подчёркиваний. Пусто → None."""
    if raw is None:
        return None
    value = re.sub(r"[\s\-_.]+", "", str(raw).upper())
    return value or None
