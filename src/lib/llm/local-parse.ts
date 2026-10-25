import {
  extractPhoneTarget,
  titleFromPhoneTask,
} from "@/lib/phone-target";
import type { ParsedReminder } from "./router";

const WEEKDAY: Record<string, number> = {
  sunday: 0,
  sun: 0,
  monday: 1,
  mon: 1,
  tuesday: 2,
  tue: 2,
  tues: 2,
  wednesday: 3,
  wed: 3,
  thursday: 4,
  thu: 4,
  thur: 4,
  thurs: 4,
  friday: 5,
  fri: 5,
  saturday: 6,
  sat: 6,
};

function zonedParts(date: Date, timeZone: string) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    weekday: "short",
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(date).map((p) => [p.type, p.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour === "24" ? "0" : parts.hour),
    minute: Number(parts.minute),
    weekday: parts.weekday,
  };
}

/** Build a Date for Y-M-D H:M in a timezone (approximate via iterative offset). */
function dateInTimeZone(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  // Start from UTC guess
  let utc = Date.UTC(year, month - 1, day, hour, minute, 0);
  for (let i = 0; i < 3; i++) {
    const p = zonedParts(new Date(utc), timeZone);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, 0);
    const wanted = Date.UTC(year, month - 1, day, hour, minute, 0);
    utc += wanted - asUtc;
  }
  return new Date(utc);
}

function stripTimePhrase(text: string): string {
  return text
    .replace(
      /\b(remind(er)?(\s+me)?(\s+to)?|every\s+\w+|daily|weekly|tomorrow|today|tonight|in\s+\d+\s*(minutes?|mins?|hours?|hrs?|days?)|(?:at|on)\s+\d{1,2}(?:[.:]\d{2})?\s*(am|pm)?|\d{1,2}[.:]\d{2}\s*(am|pm)?|on\s+(mon|tue|wed|thu|fri|sat|sun)\w*)\b/gi,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();
}

function parseClock(match: RegExpMatchArray): {
  hour: number;
  minute: number;
  ampm: string;
} {
  let hour = Number(match[1]);
  const minute = match[2] ? Number(match[2]) : 0;
  const ampm = (match[3] || "").toLowerCase();
  if (ampm === "pm" && hour < 12) hour += 12;
  if (ampm === "am" && hour === 12) hour = 0;
  return { hour, minute, ampm };
}

/**
 * Whisper often writes "11.43" with a dot.
 * Unmarked 1–11: prefer PM in the afternoon/evening, AM in the morning.
 * Always stays on baseDay (today unless user said tomorrow) — never rolls to T+1.
 */
function dueFromClock(
  match: RegExpMatchArray,
  baseDay: { year: number; month: number; day: number },
  localNow: { hour: number },
  timeZone: string,
): Date {
  const { hour, minute, ampm } = parseClock(match);
  const at = (h: number) =>
    dateInTimeZone(baseDay.year, baseDay.month, baseDay.day, h, minute, timeZone);
  const threshold = Date.now() - 30_000;

  if (ampm) return at(hour);

  // Explicit 24h (13–23) or 0
  if (hour > 12) return at(hour);
  if (hour === 0) return at(0);

  if (hour === 12) {
    // "at 12" → noon before midday, else midnight on this calendar day
    return localNow.hour < 12 ? at(12) : at(0);
  }

  const preferPm = localNow.hour >= 12;
  const primary = at(preferPm ? hour + 12 : hour);
  const secondary = at(preferPm ? hour : hour + 12);
  if (primary.getTime() >= threshold) return primary;
  if (secondary.getTime() >= threshold) return secondary;
  return primary; // still today even if slightly past (dispatcher sends ASAP)
}

/**
 * Deterministic fallback when free LLM providers are slow/down.
 * Handles common English reminder phrases for Asia/Kolkata-style use.
 */
export function parseReminderLocally(
  userText: string,
  timeZone: string,
): ParsedReminder {
  const phone = extractPhoneTarget(userText);
  const text = (phone?.textWithoutPhone || userText).trim();
  const lower = text.toLowerCase();
  const now = new Date();
  const local = zonedParts(now, timeZone);

  // Default: 1 hour from now (absolute) — clock times use *today* instead (see below)
  let due = new Date(Date.now() + 60 * 60 * 1000);
  let confidence = 0.35;
  let recurrenceType: "none" | "daily" | "weekly" = "none";
  let recurrenceWeekdays: number[] = [];
  let snoozeMinutes: number | undefined;
  let intent: ParsedReminder["intent"] = "create";
  let dayPinned = false; // tomorrow / today / weekday named
  let clockOnCalendarDay = false; // clock with no date → stay on that day, never T+1

  const snooze =
    lower.match(
      /\b(?:snooze|again|remind(?:\s+me)?\s+again)\s*(?:in\s+)?(\d+)\s*(minutes?|mins?|hours?|hrs?)\b/,
    ) || lower.match(/\bin\s+(\d+)\s*(minutes?|mins?)\b.*\b(again|snooze)\b/);
  if (/\bsnooze\b/.test(lower) || /\bagain in\b/.test(lower)) {
    intent = "snooze";
    const m =
      lower.match(/\b(\d+)\s*(minutes?|mins?|hours?|hrs?)\b/) || snooze;
    if (m) {
      const n = Number(m[1]);
      const unit = m[2];
      snoozeMinutes = /hour|hr/.test(unit) ? n * 60 : n;
      confidence = 0.7;
    } else {
      snoozeMinutes = 10;
    }
  }

  const inRel = lower.match(
    /\bin\s+(\d+)\s*(minutes?|mins?|hours?|hrs?|days?)\b/,
  );
  if (inRel && intent === "create") {
    const n = Number(inRel[1]);
    const unit = inRel[2];
    const ms = /day/.test(unit)
      ? n * 86_400_000
      : /hour|hr/.test(unit)
        ? n * 3_600_000
        : n * 60_000;
    due = new Date(Date.now() + ms);
    confidence = 0.75;
  }

  // Colon or dot minutes (Whisper: "at 11.43"); am/pm optional; bare "at 9"
  const clock =
    lower.match(/\b(?:at|on)\s+(\d{1,2})(?:[.:](\d{2}))?\s*(am|pm)\b/) ||
    lower.match(/\b(?:at|on)\s+(\d{1,2})(?:[.:](\d{2}))\b/) ||
    lower.match(/\b(?:at|on)\s+(\d{1,2})\b/) ||
    lower.match(/\b(\d{1,2})(?:[.:](\d{2}))\s*(am|pm)\b/) ||
    lower.match(/\b(\d{1,2})[.:](\d{2})\b/);

  if (/\bevery\s+day\b|\bdaily\b/.test(lower)) {
    recurrenceType = "daily";
    confidence = Math.max(confidence, 0.7);
  }

  const everyWeekday = lower.match(
    /\bevery\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)\b/,
  );
  if (everyWeekday || /\bweekly\b/.test(lower)) {
    recurrenceType = "weekly";
    if (everyWeekday) {
      recurrenceWeekdays = [WEEKDAY[everyWeekday[1]]];
    }
    confidence = Math.max(confidence, 0.7);
  }

  if (/\btomorrow\b/.test(lower)) {
    const base = dateInTimeZone(
      local.year,
      local.month,
      local.day,
      9,
      0,
      timeZone,
    );
    due = new Date(base.getTime() + 86_400_000);
    dayPinned = true;
    confidence = Math.max(confidence, 0.7);
  } else if (/\btoday\b|\btonight\b/.test(lower)) {
    due = dateInTimeZone(local.year, local.month, local.day, 18, 0, timeZone);
    if (/\btonight\b/.test(lower)) {
      due = dateInTimeZone(local.year, local.month, local.day, 20, 0, timeZone);
    }
    dayPinned = true;
    confidence = Math.max(confidence, 0.65);
  }

  if (clock) {
    // Time with no day → today in user TZ (not now+1h). Dotted times + AM/PM guess.
    const baseDay = dayPinned ? zonedParts(due, timeZone) : local;
    due = dueFromClock(clock, baseDay, local, timeZone);
    clockOnCalendarDay = true;
    confidence = Math.max(confidence, 0.85);
  }

  if (recurrenceType === "weekly" && recurrenceWeekdays.length === 0) {
    const map: Record<string, number> = {
      Sun: 0,
      Mon: 1,
      Tue: 2,
      Wed: 3,
      Thu: 4,
      Fri: 5,
      Sat: 6,
    };
    recurrenceWeekdays = [map[zonedParts(due, timeZone).weekday] ?? 1];
  }

  // Push past due times into the future — but never for bare clock times (stay today)
  if (due.getTime() < Date.now() - 30_000) {
    if (recurrenceType === "daily") {
      due = new Date(due.getTime() + 86_400_000);
    } else if (recurrenceType === "weekly" && recurrenceWeekdays.length) {
      for (let i = 0; i < 8 && due.getTime() < Date.now(); i++) {
        due = new Date(due.getTime() + 86_400_000);
        const wd = zonedParts(due, timeZone).weekday;
        const map: Record<string, number> = {
          Sun: 0,
          Mon: 1,
          Tue: 2,
          Wed: 3,
          Thu: 4,
          Fri: 5,
          Sat: 6,
        };
        if (recurrenceWeekdays.includes(map[wd] ?? -1)) break;
      }
    } else if (!clockOnCalendarDay) {
      due = new Date(due.getTime() + 86_400_000);
    }
    // clockOnCalendarDay: keep today; if already past, cron will send immediately
  }

  const cleaned = stripTimePhrase(text)
    .replace(/\s*\.\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const title = phone
    ? titleFromPhoneTask(phone.textWithoutPhone)
    : cleaned
      ? cleaned.charAt(0).toUpperCase() + cleaned.slice(1)
      : text.slice(0, 80) || "Reminder";

  return {
    intent,
    title,
    body: null,
    dueAt: due.toISOString(),
    confidence: phone ? Math.max(confidence, 0.85) : confidence,
    recurrenceType,
    recurrenceWeekdays,
    tags: [],
    snoozeMinutes,
    /** Phone digits or saved target name — resolved to ChatTarget on save */
    targetHint: phone?.digits ?? null,
  };
}
