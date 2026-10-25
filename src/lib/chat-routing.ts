import { getWahaConfig } from "@/lib/env";

/** Group where remind / snooze / list / voice reminders are accepted. */
export function getReminderGroupChatId(): string {
  return (
    process.env.REMINDER_GROUP_CHAT_ID?.trim() ||
    process.env.WHATSAPP_CHAT_ID?.trim() ||
    ""
  );
}

/**
 * Where "reply to this person" reminders are delivered
 * (your personal phone, not the WAHA-linked number).
 */
export function getOwnerNotifyChatId(): string {
  const raw =
    process.env.OWNER_NOTIFY_CHAT_ID?.trim() ||
    process.env.OWNER_PHONE_CHAT_ID?.trim() ||
    "";
  if (!raw) return "";
  return normalizeChatId(raw.includes("@") ? raw : phoneToChatId(raw));
}

/** Minutes until a personal-DM reply reminder fires for Deepak (default 60). */
export function getPersonalReplyDelayMinutes(): number {
  const n = Number(process.env.PERSONAL_REPLY_DELAY_MINUTES || 60);
  if (!Number.isFinite(n) || n < 1) return 60;
  return Math.min(n, 60 * 24 * 7);
}

/**
 * How long to wait before AI answers a personal DM.
 * If Deepak replies in this window, AI stays silent (default 5).
 */
export function getPersonalDmAiDelayMinutes(): number {
  const n = Number(process.env.PERSONAL_DM_AI_DELAY_MINUTES || 5);
  if (!Number.isFinite(n) || n < 1) return 5;
  return Math.min(n, 60);
}

function phoneToChatId(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (!digits) return "";
  const withCc = digits.length === 10 ? `91${digits}` : digits;
  return `${withCc}@c.us`;
}

/**
 * Normalize WAHA chat ids:
 * - trim
 * - `@s.whatsapp.net` → `@c.us`
 * Keep `@lid` as-is (must reply to the same LID).
 */
export function normalizeChatId(chatId: string): string {
  const id = chatId.trim();
  if (id.endsWith("@s.whatsapp.net")) {
    return `${id.slice(0, -"@s.whatsapp.net".length)}@c.us`;
  }
  if (!id.includes("@") && /^\d{10,15}$/.test(id)) {
    return `${id}@c.us`;
  }
  return id;
}

export function isGroupChat(chatId: string): boolean {
  return normalizeChatId(chatId).endsWith("@g.us");
}

/**
 * 1:1 DM — WhatsApp now often sends `@lid` instead of `@c.us`.
 * Reply using the same id you received.
 */
export function isPersonalChat(chatId: string): boolean {
  const id = normalizeChatId(chatId);
  return id.endsWith("@c.us") || id.endsWith("@lid");
}

export function isReminderGroupChat(chatId: string): boolean {
  const group = getReminderGroupChatId();
  if (!group) return false;
  return normalizeChatId(chatId) === normalizeChatId(group);
}

/** Skip DMs from your own notify phone (avoid loops). */
export function isOwnerNotifyChat(chatId: string): boolean {
  const owner = getOwnerNotifyChatId();
  if (!owner) return false;
  const id = normalizeChatId(chatId);
  if (id === owner) return true;
  // Same phone digits when both are @c.us
  const ownerDigits = owner.replace(/@c\.us$/i, "").replace(/\D/g, "");
  const idDigits = id.replace(/@c\.us$/i, "").replace(/\D/g, "");
  return Boolean(
    ownerDigits &&
      idDigits &&
      id.endsWith("@c.us") &&
      owner.endsWith("@c.us") &&
      ownerDigits === idDigits,
  );
}

/** Env WHATSAPP_CHAT_ID still used as default delivery for group-created reminders. */
export function getDefaultDeliveryChatId(): string | null {
  return getWahaConfig().chatId;
}
