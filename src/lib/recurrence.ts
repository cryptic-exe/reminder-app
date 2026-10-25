import type { RecurrenceType } from "@prisma/client";
import { getUserTimezone } from "@/lib/env";

/** Compute the next due datetime after `from` for a recurrence rule. */
export function nextDueAfter(input: {
  from: Date;
  recurrenceType: RecurrenceType;
  recurrenceWeekdays: number[];
  timezone?: string;
}): Date | null {
  const { from, recurrenceType, recurrenceWeekdays } = input;
  if (recurrenceType === "none") return null;

  const tz = input.timezone || getUserTimezone();

  if (recurrenceType === "daily") {
    return addDaysKeepingLocalTime(from, 1, tz);
  }

  // weekly — find next matching weekday (or same weekday + 7 if empty)
  const days =
    recurrenceWeekdays.length > 0
      ? [...new Set(recurrenceWeekdays)].sort((a, b) => a - b)
      : [getWeekdayInTz(from, tz)];

  for (let add = 1; add <= 14; add++) {
    const candidate = addDaysKeepingLocalTime(from, add, tz);
    const wd = getWeekdayInTz(candidate, tz);
    if (days.includes(wd)) return candidate;
  }
  return addDaysKeepingLocalTime(from, 7, tz);
}

function getWeekdayInTz(date: Date, timeZone: string): number {
  // 'short' weekday in en-US → Sun, Mon, ...
  const name = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
  }).format(date);
  const map: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  return map[name] ?? date.getUTCDay();
}

/** Add calendar days while preserving wall-clock time in the user timezone. */
function addDaysKeepingLocalTime(
  date: Date,
  days: number,
  timeZone: string,
): Date {
  const parts = getTzParts(date, timeZone);
  const asUtcGuess = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day + days,
    parts.hour,
    parts.minute,
    parts.second,
  );
  // Adjust for timezone offset at that local instant
  const offsetMs = getTimeZoneOffsetMs(new Date(asUtcGuess), timeZone);
  return new Date(asUtcGuess - offsetMs);
}

function getTzParts(date: Date, timeZone: string) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const bag: Record<string, string> = {};
  for (const p of fmt.formatToParts(date)) {
    if (p.type !== "literal") bag[p.type] = p.value;
  }
  return {
    year: Number(bag.year),
    month: Number(bag.month),
    day: Number(bag.day),
    hour: bag.hour === "24" ? 0 : Number(bag.hour),
    minute: Number(bag.minute),
    second: Number(bag.second),
  };
}

function getTimeZoneOffsetMs(date: Date, timeZone: string): number {
  // Difference between local wall time interpreted as UTC and actual UTC
  const parts = getTzParts(date, timeZone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return asUtc - date.getTime();
}

export function snoozeFromNow(minutes: number): Date {
  return new Date(Date.now() + minutes * 60_000);
}

export const WEEKDAY_LABELS = [
  "Sun",
  "Mon",
  "Tue",
  "Wed",
  "Thu",
  "Fri",
  "Sat",
] as const;
