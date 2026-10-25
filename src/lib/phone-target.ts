/** Detect "remind <phone> to …" and normalize to a WAHA chat id. */

export type PhoneTarget = {
  /** Digits only, with country code when possible */
  digits: string;
  chatId: string;
  /** Display name for ChatTarget */
  name: string;
  /** Task text without the phone routing phrase (may still include time) */
  textWithoutPhone: string;
};

function cleanInbound(text: string): string {
  return text
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "") // bidi / WhatsApp marks
    .replace(/\u00a0/g, " ")
    .trim();
}

export function normalizePhoneDigits(raw: string): string | null {
  let digits = raw.replace(/\D/g, "");
  if (digits.length < 10 || digits.length > 15) return null;
  // Common India local numbers → add 91
  if (digits.length === 10) digits = `91${digits}`;
  return digits;
}

/**
 * "remind 9198XXXXXXXX to send images on 10:32PM"
 * "remind +91 98XXXXXXXX to Send image on 10:38PM"
 * "remind +91 96671 64402 to call me at 5"
 */
export function extractPhoneTarget(text: string): PhoneTarget | null {
  const cleaned = cleanInbound(text);

  const patterns = [
    // remind[er] <phone> to <rest>
    /^\s*remind(?:er)?\s+(?:\+?(\d[\d\s-]{8,18}\d))\s+to\s+(.+)$/i,
    // remind[er] <phone> <rest> (no "to")
    /^\s*remind(?:er)?\s+(?:\+?(\d[\d\s-]{8,18}\d))\s+(.+)$/i,
  ];

  for (const re of patterns) {
    const m = cleaned.match(re);
    if (!m) continue;
    const digits = normalizePhoneDigits(m[1]);
    if (!digits) continue;
    let rest = m[2].trim().replace(/^\s*to\s+/i, "").trim();
    if (!rest) continue;
    return {
      digits,
      chatId: `${digits}@c.us`,
      name: digits,
      textWithoutPhone: rest,
    };
  }

  // Fallback: any 10–15 digit run after remind…to
  const loose = cleaned.match(
    /^\s*remind(?:er)?\s+.*?(\+?\d[\d\s-]{8,18}\d).*?\bto\s+(.+)$/i,
  );
  if (loose) {
    const digits = normalizePhoneDigits(loose[1]);
    if (digits) {
      return {
        digits,
        chatId: `${digits}@c.us`,
        name: digits,
        textWithoutPhone: loose[2].trim(),
      };
    }
  }

  return null;
}

/** Clean title for the recipient message (drop leftover time phrases). */
export function titleFromPhoneTask(taskText: string): string {
  const cleaned = taskText
    .replace(/\b(?:on|at)\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "Reminder";
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}
