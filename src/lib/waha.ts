import {
  getUserTimezone,
  getWahaConfig,
  getWahaServerConfig,
  requireDefaultChatId,
} from "@/lib/env";

export type WahaSendResult = {
  messageId?: string;
  raw: unknown;
};

export type WahaSessionStatus =
  | "STOPPED"
  | "STARTING"
  | "SCAN_QR_CODE"
  | "WORKING"
  | "FAILED"
  | "PASSKEY_REQUIRED"
  | "PASSKEY_CONFIRMATION_REQUIRED"
  | string;

export type WahaSessionInfo = {
  name: string;
  status: WahaSessionStatus;
  me: {
    id?: string;
    pushName?: string;
  } | null;
  engine?: { engine?: string } | null;
  raw: unknown;
};

async function wahaFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const { baseUrl, apiKey } = getWahaServerConfig();
  const headers = new Headers(init.headers);
  headers.set("X-Api-Key", apiKey);
  if (!headers.has("Accept")) headers.set("Accept", "application/json");
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers,
    cache: "no-store",
  });
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function wahaError(action: string, res: Response, raw: unknown): Error {
  const detail =
    raw && typeof raw === "object"
      ? JSON.stringify(raw)
      : typeof raw === "string" && raw
        ? raw
        : `HTTP ${res.status}`;
  return new Error(`WAHA ${action} failed: ${detail}`);
}

function normalizeSession(raw: unknown, fallbackName: string): WahaSessionInfo {
  const obj = (raw && typeof raw === "object" ? raw : {}) as {
    name?: string;
    status?: string;
    me?: { id?: string; pushName?: string } | null;
    engine?: { engine?: string } | null;
  };
  return {
    name: obj.name || fallbackName,
    status: (obj.status || "STOPPED") as WahaSessionStatus,
    me: obj.me ?? null,
    engine: obj.engine ?? null,
    raw,
  };
}

export async function getWahaSession(): Promise<WahaSessionInfo | null> {
  const { session } = getWahaServerConfig();
  const res = await wahaFetch(`/api/sessions/${encodeURIComponent(session)}`);
  if (res.status === 404) return null;
  const raw = await readJson(res);
  if (!res.ok) throw wahaError("get session", res, raw);
  return normalizeSession(raw, session);
}

export async function ensureWahaSession(): Promise<WahaSessionInfo> {
  const existing = await getWahaSession();
  if (existing) return existing;

  const { session } = getWahaServerConfig();
  const res = await wahaFetch("/api/sessions", {
    method: "POST",
    body: JSON.stringify({ name: session }),
  });
  const raw = await readJson(res);
  // Some WAHA versions return 422/409 if it already exists
  if (!res.ok && res.status !== 422 && res.status !== 409) {
    throw wahaError("create session", res, raw);
  }
  const after = await getWahaSession();
  if (after) return after;
  return normalizeSession(raw, session);
}

export async function startWahaSession(): Promise<WahaSessionInfo> {
  const session = await ensureWahaSession();
  const res = await wahaFetch(
    `/api/sessions/${encodeURIComponent(session.name)}/start`,
    { method: "POST", body: "{}" },
  );
  const raw = await readJson(res);
  if (!res.ok) throw wahaError("start session", res, raw);
  return (await getWahaSession()) ?? normalizeSession(raw, session.name);
}

export async function stopWahaSession(): Promise<WahaSessionInfo | null> {
  const { session } = getWahaServerConfig();
  const res = await wahaFetch(
    `/api/sessions/${encodeURIComponent(session)}/stop`,
    { method: "POST", body: "{}" },
  );
  const raw = await readJson(res);
  if (!res.ok && res.status !== 404) throw wahaError("stop session", res, raw);
  return getWahaSession();
}

export async function restartWahaSession(): Promise<WahaSessionInfo> {
  const { session } = getWahaServerConfig();
  const res = await wahaFetch(
    `/api/sessions/${encodeURIComponent(session)}/restart`,
    { method: "POST", body: "{}" },
  );
  const raw = await readJson(res);
  if (!res.ok) throw wahaError("restart session", res, raw);
  return (await getWahaSession()) ?? normalizeSession(raw, session);
}

export async function logoutWahaSession(): Promise<WahaSessionInfo | null> {
  const { session } = getWahaServerConfig();
  const res = await wahaFetch(
    `/api/sessions/${encodeURIComponent(session)}/logout`,
    { method: "POST", body: "{}" },
  );
  const raw = await readJson(res);
  if (!res.ok && res.status !== 404) throw wahaError("logout session", res, raw);
  return getWahaSession();
}

export async function getWahaQr(): Promise<{
  mimetype?: string;
  data?: string;
  value?: string;
}> {
  const { session } = getWahaServerConfig();
  const res = await wahaFetch(`/api/${encodeURIComponent(session)}/auth/qr`, {
    headers: { Accept: "application/json" },
  });
  const raw = await readJson(res);
  if (!res.ok) throw wahaError("get QR", res, raw);

  if (raw && typeof raw === "object") {
    const obj = raw as {
      mimetype?: string;
      data?: string;
      value?: string;
    };
    return {
      mimetype: obj.mimetype,
      data: obj.data,
      value: obj.value,
    };
  }
  throw new Error("WAHA get QR returned unexpected payload");
}

export async function requestWahaPairingCode(phoneNumber: string): Promise<{
  code: string;
}> {
  const { session } = getWahaServerConfig();
  const digits = phoneNumber.replace(/\D/g, "");
  if (digits.length < 8) {
    throw new Error("Enter phone number in international format, digits only");
  }

  const res = await wahaFetch(
    `/api/${encodeURIComponent(session)}/auth/request-code`,
    {
      method: "POST",
      body: JSON.stringify({ phoneNumber: digits }),
    },
  );
  const raw = await readJson(res);
  if (!res.ok) throw wahaError("request pairing code", res, raw);

  const code =
    raw &&
    typeof raw === "object" &&
    "code" in raw &&
    typeof (raw as { code: unknown }).code === "string"
      ? (raw as { code: string }).code
      : null;

  if (!code) throw new Error("WAHA did not return a pairing code");
  return { code };
}

export function formatReminderMessage(input: {
  title: string;
  body?: string | null;
  rawInput?: string | null;
  dueAt: Date;
  reminderId?: string;
  /** Short message for someone else (no raw command / snooze hints). */
  compact?: boolean;
}): string {
  // Always use cleaned title — never the raw "remind 91… to …" command text
  const message =
    [input.title.trim(), input.body?.trim()].filter(Boolean).join("\n") ||
    input.rawInput?.trim() ||
    "Reminder";

  if (input.compact) {
    return `⏰ Reminder: ${message}`;
  }

  const timezone = getUserTimezone();
  const dueDate = new Intl.DateTimeFormat("en-IN", {
    timeZone: timezone,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(input.dueAt);

  const lines = [`⏰ Reminder: ${message}`, `Due: ${dueDate}`];
  if (input.reminderId) {
    lines.push(`Reply: snooze 10 / snooze 1h  (id:${input.reminderId.slice(-6)})`);
  }
  return lines.join("\n\n");
}

export async function sendWhatsAppText(
  text: string,
  chatId?: string | null,
): Promise<WahaSendResult> {
  const { session, chatId: envChatId } = getWahaConfig();
  const target = chatId || envChatId || requireDefaultChatId();

  const res = await wahaFetch("/api/sendText", {
    method: "POST",
    body: JSON.stringify({
      session,
      chatId: target,
      text,
    }),
  });

  const raw = await readJson(res);

  if (!res.ok) {
    throw wahaError("sendText", res, raw);
  }

  const messageId =
    raw &&
    typeof raw === "object" &&
    "id" in raw &&
    typeof (raw as { id: unknown }).id === "string"
      ? (raw as { id: string }).id
      : raw &&
          typeof raw === "object" &&
          "key" in raw &&
          typeof (raw as { key?: { id?: string } }).key?.id === "string"
        ? (raw as { key: { id: string } }).key.id
        : undefined;

  return { messageId, raw };
}

/** Download a WAHA media URL (needs X-Api-Key). */
export async function downloadWahaMedia(url: string): Promise<{
  bytes: Buffer;
  mime: string;
}> {
  const { baseUrl, apiKey } = getWahaServerConfig();
  // media.url may be absolute on WAHA host or relative /api/files/...
  const absolute = url.startsWith("http")
    ? url
    : `${baseUrl}${url.startsWith("/") ? "" : "/"}${url}`;
  // Rewrite localhost URLs to the configured WAHA base (webhook payloads often use localhost)
  let fetchUrl = absolute;
  try {
    const u = new URL(absolute);
    if (u.hostname === "localhost" || u.hostname === "127.0.0.1") {
      const base = new URL(baseUrl);
      u.protocol = base.protocol;
      u.host = base.host;
      fetchUrl = u.toString();
    }
  } catch {
    /* keep absolute */
  }

  const res = await fetch(fetchUrl, {
    headers: { "X-Api-Key": apiKey, Accept: "*/*" },
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`WAHA media download failed: HTTP ${res.status}`);
  }
  const mime =
    res.headers.get("content-type") || "audio/ogg; codecs=opus";
  const ab = await res.arrayBuffer();
  return { bytes: Buffer.from(ab), mime };
}

export async function sendWhatsAppVoice(input: {
  bytes: Buffer;
  mime?: string;
  chatId?: string | null;
  filename?: string;
}): Promise<WahaSendResult> {
  const { session, chatId: envChatId } = getWahaConfig();
  const target = input.chatId || envChatId || requireDefaultChatId();
  const mime = input.mime || "audio/ogg; codecs=opus";
  const res = await wahaFetch("/api/sendVoice", {
    method: "POST",
    body: JSON.stringify({
      session,
      chatId: target,
      file: {
        mimetype: mime,
        filename: input.filename || "reminder-voice.ogg",
        data: input.bytes.toString("base64"),
      },
      // Convert non-opus formats (mp3/webm/etc.) for WhatsApp
      convert: true,
    }),
  });
  const raw = await readJson(res);
  if (!res.ok) throw wahaError("sendVoice", res, raw);

  const messageId =
    raw &&
    typeof raw === "object" &&
    "id" in raw &&
    typeof (raw as { id: unknown }).id === "string"
      ? (raw as { id: string }).id
      : undefined;

  return { messageId, raw };
}

export async function sendReminderWhatsApp(reminder: {
  title: string;
  body?: string | null;
  rawInput?: string | null;
  dueAt: Date;
  chatId?: string | null;
  reminderId?: string;
  compact?: boolean;
  voicePath?: string | null;
  voiceMime?: string | null;
}): Promise<WahaSendResult> {
  const { chatId: envChatId } = getWahaConfig();
  const target = reminder.chatId || envChatId;
  const compact =
    reminder.compact ??
    Boolean(target && envChatId && target !== envChatId);

  // Prefer re-sending the original voice note when present
  if (reminder.voicePath) {
    const { readVoiceFile } = await import("@/lib/voice-store");
    const { bytes } = await readVoiceFile(reminder.voicePath);
    const voice = await sendWhatsAppVoice({
      bytes,
      mime: reminder.voiceMime || undefined,
      chatId: reminder.chatId,
    });
    // For your own chat, also send snooze controls as text
    if (!compact && reminder.reminderId) {
      await sendWhatsAppText(
        formatReminderMessage({
          title: reminder.title || "Voice reminder",
          body: reminder.body,
          dueAt: reminder.dueAt,
          reminderId: reminder.reminderId,
          compact: false,
        }),
        reminder.chatId,
      ).catch(() => undefined);
    }
    return voice;
  }

  const text = formatReminderMessage({ ...reminder, compact });
  return sendWhatsAppText(text, reminder.chatId);
}

export type WahaChatMessage = {
  id: string;
  timestamp: number;
  from: string;
  fromMe: boolean;
  body: string;
  source?: string;
  hasMedia?: boolean;
  media?: { url?: string | null; mimetype?: string | null; filename?: string | null } | null;
};

/**
 * Resolve WhatsApp LID for a phone JID (`9198…@c.us` → `…@lid`).
 * GOWS often delivers owner replies as @lid only.
 */
export async function fetchLidForPhoneJid(
  phoneJid: string,
): Promise<string | null> {
  const { session } = getWahaServerConfig();
  const pn = phoneJid.endsWith("@c.us")
    ? phoneJid
    : phoneJid.includes("@")
      ? phoneJid
      : `${phoneJid.replace(/\D/g, "")}@c.us`;
  const encoded = encodeURIComponent(pn);
  const res = await wahaFetch(
    `/api/${encodeURIComponent(session)}/lids/pn/${encoded}`,
  );
  const raw = await readJson(res);
  if (!res.ok) return null;
  if (raw && typeof raw === "object") {
    const lid = (raw as { lid?: string }).lid;
    if (typeof lid === "string" && lid.endsWith("@lid")) return lid;
  }
  return null;
}

/** Recent messages in a chat (newest first). Used to poll snooze/commands locally. */
export async function fetchChatMessages(
  chatId: string,
  limit = 20,
  downloadMedia = false,
): Promise<WahaChatMessage[]> {
  const { session } = getWahaServerConfig();
  const encoded = encodeURIComponent(chatId);
  const res = await wahaFetch(
    `/api/${encodeURIComponent(session)}/chats/${encoded}/messages?limit=${limit}&downloadMedia=${downloadMedia}`,
  );
  const raw = await readJson(res);
  if (!res.ok) throw wahaError("list messages", res, raw);

  const list = Array.isArray(raw) ? raw : [];
  return list
    .map((item): WahaChatMessage | null => {
      if (!item || typeof item !== "object") return null;
      const m = item as Record<string, unknown>;
      const id = typeof m.id === "string" ? m.id : "";
      const body =
        (typeof m.body === "string" && m.body) ||
        (typeof m.text === "string" && m.text) ||
        "";
      const from = typeof m.from === "string" ? m.from : chatId;
      const timestamp =
        typeof m.timestamp === "number"
          ? m.timestamp
          : typeof m.timestamp === "string"
            ? Number(m.timestamp)
            : 0;
      const mediaObj =
        m.media && typeof m.media === "object"
          ? (m.media as Record<string, unknown>)
          : null;
      const media = mediaObj
        ? {
            url: typeof mediaObj.url === "string" ? mediaObj.url : null,
            mimetype:
              typeof mediaObj.mimetype === "string" ? mediaObj.mimetype : null,
            filename:
              typeof mediaObj.filename === "string" ? mediaObj.filename : null,
          }
        : null;
      const hasMedia = m.hasMedia === true || Boolean(media);
      if (!id) return null;
      if (!body.trim() && !hasMedia) return null;
      return {
        id,
        timestamp,
        from,
        fromMe: m.fromMe === true,
        body: body.trim(),
        source: typeof m.source === "string" ? m.source : undefined,
        hasMedia,
        media,
      };
    })
    .filter((m): m is WahaChatMessage => m != null);
}

export type WahaInboundIgnoreConfig = {
  status: boolean;
  groups: boolean;
  channels: boolean;
  broadcast: boolean;
};

/**
 * WAHA only filters by chat *type* (`config.ignore`), not by a specific group id.
 * Keep `groups: false` so the reminder group still webhooks + stores; drop
 * status / channels / broadcast at the engine to cut Fast Data Transfer.
 */
export const WAHA_INBOUND_IGNORE: WahaInboundIgnoreConfig = {
  status: true,
  groups: false,
  channels: true,
  broadcast: true,
};

function resolveWebhookPublicUrl(): string | null {
  const fromEnv =
    process.env.WAHA_WEBHOOK_URL?.trim() ||
    process.env.APP_URL?.trim() ||
    process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim() ||
    "";
  if (!fromEnv) return null;
  const base = fromEnv.startsWith("http")
    ? fromEnv.replace(/\/$/, "")
    : `https://${fromEnv.replace(/\/$/, "")}`;
  if (base.includes("/api/webhooks/waha")) return base;
  return `${base}/api/webhooks/waha`;
}

/**
 * Apply engine-side ignore filters and (when URL+secret known) the prod webhook.
 * Preserves an existing webhook URL if env does not define one.
 */
export async function syncWahaInboundFilters(options?: {
  webhookUrl?: string | null;
  webhookSecret?: string | null;
}): Promise<{
  ignore: WahaInboundIgnoreConfig;
  webhookUrl: string | null;
  events: string[];
}> {
  const { session } = getWahaServerConfig();
  const existing = await getWahaSession();
  if (!existing) {
    throw new Error("WAHA session does not exist yet");
  }

  const raw = existing.raw as {
    config?: {
      ignore?: Partial<WahaInboundIgnoreConfig>;
      webhooks?: Array<{
        url?: string;
        events?: string[];
        retries?: { delaySeconds?: number; attempts?: number };
      }>;
    };
  };

  const secret =
    options?.webhookSecret?.trim() ||
    process.env.WAHA_WEBHOOK_SECRET?.trim() ||
    process.env.CRON_SECRET?.trim() ||
    "";

  let webhookUrl =
    options?.webhookUrl?.trim() ||
    resolveWebhookPublicUrl() ||
    raw.config?.webhooks?.[0]?.url ||
    null;

  if (webhookUrl && secret && !webhookUrl.includes("secret=")) {
    const joiner = webhookUrl.includes("?") ? "&" : "?";
    webhookUrl = `${webhookUrl}${joiner}secret=${encodeURIComponent(secret)}`;
  }

  const events = ["message.any"] as string[];
  const webhooks = webhookUrl
    ? [
        {
          url: webhookUrl,
          events,
          retries: {
            delaySeconds: 2,
            attempts: 3,
          },
        },
      ]
    : (raw.config?.webhooks ?? []);

  const res = await wahaFetch(`/api/sessions/${encodeURIComponent(session)}`, {
    method: "PUT",
    body: JSON.stringify({
      name: session,
      config: {
        ignore: WAHA_INBOUND_IGNORE,
        webhooks,
      },
    }),
  });
  const body = await readJson(res);
  if (!res.ok) throw wahaError("sync inbound filters", res, body);

  return {
    ignore: WAHA_INBOUND_IGNORE,
    webhookUrl: webhookUrl ?? null,
    events,
  };
}
