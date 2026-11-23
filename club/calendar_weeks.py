from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

MOSCOW = ZoneInfo("Europe/Moscow")
WEEK = timedelta(days=7)


def today_in_moscow():
    return datetime.now(MOSCOW).date()


def monday_of(day):
    return day - timedelta(days=day.weekday())


def workout_summary(days, monday):
    dates = [date.fromisoformat(day) for day in days]
    weeks = {monday_of(day) for day in dates}
    active_week = monday if monday in weeks else monday - WEEK
    streak = 0
    while active_week in weeks:
        streak += 1
        active_week -= WEEK
    return sum(monday <= day < monday + WEEK for day in dates), streak


def date_label(day):
    months = (
        "января", "февраля", "марта", "апреля", "мая", "июня",
        "июля", "августа", "сентября", "октября", "ноября", "декабря",
    )
    return f"{day.day} {months[day.month - 1]}"
