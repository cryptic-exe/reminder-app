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

/** Optional explicit LID for owner phone (GOWS often sends @lid). */
export function getOwnerNotifyLidFromEnv(): string {
  const raw = process.env.OWNER_NOTIFY_LID?.trim() || "";
  return raw ? normalizeChatId(raw) : "";
}

/** Minutes until a personal-DM reply reminder fires for Deepak (default 60). */
export function getPersonalReplyDelayMinutes(): number {
  const n = Number(process.env.PERSONAL_REPLY_DELAY_MINUTES || 60);
  if (!Number.isFinite(n) || n < 1) return 60;
  return Math.min(n, 60 * 24 * 7);
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

/** Cached owner identities: phone @c.us + resolved @lid */
let ownerIdentityCache: string[] | null = null;
let ownerLidRefresh: Promise<void> | null = null;

function baseOwnerIdentities(): string[] {
  const ids: string[] = [];
  const owner = getOwnerNotifyChatId();
  if (owner) ids.push(owner);
  const envLid = getOwnerNotifyLidFromEnv();
  if (envLid) ids.push(envLid);
  return ids;
}

/** Sync check using env + in-memory LID cache. */
export function isOwnerNotifyChat(chatId: string): boolean {
  const id = normalizeChatId(chatId);
  const known = new Set(
    [...baseOwnerIdentities(), ...(ownerIdentityCache || [])].map(normalizeChatId),
  );
  if (known.has(id)) return true;

  const owner = getOwnerNotifyChatId();
  if (!owner) return false;
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

/** Refresh owner @lid from WAHA (call from inbound paths). */
export async function ensureOwnerNotifyIdentities(): Promise<string[]> {
  if (ownerIdentityCache?.some((x) => x.endsWith("@lid"))) {
    return [...baseOwnerIdentities(), ...ownerIdentityCache];
  }
  if (!ownerLidRefresh) {
    ownerLidRefresh = (async () => {
      const owner = getOwnerNotifyChatId();
      if (!owner) {
        ownerIdentityCache = baseOwnerIdentities();
        return;
      }
      try {
        const { fetchLidForPhoneJid } = await import("@/lib/waha");
        const lid = await fetchLidForPhoneJid(owner);
        const set = new Set(baseOwnerIdentities());
        if (lid) set.add(normalizeChatId(lid));
        ownerIdentityCache = [...set];
      } catch (err) {
        console.warn(
          "[chat-routing] owner LID resolve failed:",
          err instanceof Error ? err.message : err,
        );
        ownerIdentityCache = baseOwnerIdentities();
      }
    })().finally(() => {
      ownerLidRefresh = null;
    });
  }
  await ownerLidRefresh;
  return [...baseOwnerIdentities(), ...(ownerIdentityCache || [])];
}

export async function isOwnerNotifyChatAsync(chatId: string): Promise<boolean> {
  const ids = await ensureOwnerNotifyIdentities();
  const id = normalizeChatId(chatId);
  return ids.map(normalizeChatId).includes(id) || isOwnerNotifyChat(chatId);
}

/** Env WHATSAPP_CHAT_ID still used as default delivery for group-created reminders. */
export function getDefaultDeliveryChatId(): string | null {
  return getWahaConfig().chatId;
}
