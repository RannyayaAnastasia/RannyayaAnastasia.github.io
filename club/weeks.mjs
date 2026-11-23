const moscow = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit',
});

export function todayInMoscow(now = new Date()) {
  const parts = Object.fromEntries(moscow.formatToParts(now).map(part => [part.type, part.value]));
  return [parts.year, parts.month, parts.day].join('-');
}

export function shiftDay(day, offset) {
  const date = new Date(day + 'T00:00:00Z');
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

export function mondayOf(day) {
  const weekday = new Date(day + 'T00:00:00Z').getUTCDay();
  return shiftDay(day, -((weekday + 6) % 7));
}

export function workoutSummary(days, monday) {
  const weeks = new Set(days.map(mondayOf));
  const nextMonday = shiftDay(monday, 7);
  let activeWeek = weeks.has(monday) ? monday : shiftDay(monday, -7);
  let streak = 0;
  while (weeks.has(activeWeek)) {
    streak += 1;
    activeWeek = shiftDay(activeWeek, -7);
  }
  return {
    count: days.filter(day => day >= monday && day < nextMonday).length,
    streak,
  };
}
