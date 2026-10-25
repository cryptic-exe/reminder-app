export function getUserTimezone(): string {
  return process.env.USER_TIMEZONE || "Asia/Kolkata";
}

/** Ensure WAHA_BASE_URL is a valid absolute URL (adds http:// if missing). */
function normalizeWahaBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/$/, "");
  if (!trimmed) return trimmed;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `http://${trimmed}`;
}

/** WAHA server connection (enough for session setup). */
export function getWahaServerConfig() {
  const raw = process.env.WAHA_BASE_URL;
  const apiKey = process.env.WAHA_API_KEY;
  const session = process.env.WAHA_SESSION || "default";

  if (!raw?.trim() || !apiKey) {
    throw new Error("WAHA_BASE_URL and WAHA_API_KEY must be set");
  }

  const baseUrl = normalizeWahaBaseUrl(raw);
  return { baseUrl, apiKey, session };
}

/** Full WAHA config including fallback destination chat. */
export function getWahaConfig() {
  const server = getWahaServerConfig();
  const chatId = process.env.WHATSAPP_CHAT_ID;
  return { ...server, chatId: chatId || null };
}

export function requireDefaultChatId(): string {
  const chatId = process.env.WHATSAPP_CHAT_ID;
  if (!chatId) {
    throw new Error(
      "No chat target. Add one in Settings or set WHATSAPP_CHAT_ID.",
    );
  }
  return chatId;
}

export function getCronSecret(): string {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    throw new Error("CRON_SECRET is not set");
  }
  return secret;
}

/** Shared secret for WAHA → app webhooks (optional; falls back to CRON_SECRET). */
export function getWebhookSecret(): string {
  return process.env.WAHA_WEBHOOK_SECRET || getCronSecret();
}
