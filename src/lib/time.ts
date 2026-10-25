import { getUserTimezone } from "@/lib/env";

/** Format an ISO/UTC date for display in the user timezone. */
export function formatInUserTz(
  isoOrDate: string | Date,
  timezone = typeof window === "undefined"
    ? getUserTimezone()
    : undefined,
): string {
  const date = typeof isoOrDate === "string" ? new Date(isoOrDate) : isoOrDate;
  if (Number.isNaN(date.getTime())) return "—";
  const tz =
    timezone ||
    Intl.DateTimeFormat().resolvedOptions().timeZone ||
    "UTC";

  return new Intl.DateTimeFormat(undefined, {
    timeZone: tz,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

/** Convert ISO string to value usable by <input type="datetime-local"> in local browser TZ. */
export function toDatetimeLocalValue(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Convert datetime-local value (browser local) to ISO UTC string.
 * Returns null while the input is empty or incomplete (browsers fire onChange mid-edit).
 */
export function fromDatetimeLocalValue(value: string): string | null {
  if (!value || value.trim().length < 16) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}
