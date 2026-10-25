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
  if (raw.includes("@")) return raw;
  const digits = raw.replace(/\D/g, "");
  if (!digits) return "";
  const withCc = digits.length === 10 ? `91${digits}` : digits;
  return `${withCc}@c.us`;
}

/** Minutes until a personal-DM reply reminder fires (default 60). */
export function getPersonalReplyDelayMinutes(): number {
  const n = Number(process.env.PERSONAL_REPLY_DELAY_MINUTES || 60);
  if (!Number.isFinite(n) || n < 1) return 60;
  return Math.min(n, 60 * 24 * 7);
}

export function isGroupChat(chatId: string): boolean {
  return chatId.endsWith("@g.us");
}

export function isPersonalChat(chatId: string): boolean {
  return chatId.endsWith("@c.us");
}

export function isReminderGroupChat(chatId: string): boolean {
  const group = getReminderGroupChatId();
  return Boolean(group && chatId === group);
}

/** Skip DMs from your own notify phone (avoid loops). */
export function isOwnerNotifyChat(chatId: string): boolean {
  const owner = getOwnerNotifyChatId();
  return Boolean(owner && chatId === owner);
}

export function normalizeChatId(chatId: string): string {
  return chatId.trim();
}

/** Env WHATSAPP_CHAT_ID still used as default delivery for group-created reminders. */
export function getDefaultDeliveryChatId(): string | null {
  return getWahaConfig().chatId;
}
