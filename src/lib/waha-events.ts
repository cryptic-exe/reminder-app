import { getWahaServerConfig } from "@/lib/env";
import { routeInboundMessage } from "@/lib/inbound-router";


let started = false;
let socket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function nestedText(payload: Record<string, unknown>): string {
  const data =
    payload._data && typeof payload._data === "object"
      ? (payload._data as Record<string, unknown>)
      : null;
  const message =
    data?.Message && typeof data.Message === "object"
      ? (data.Message as Record<string, unknown>)
      : null;
  const ext =
    message?.extendedTextMessage &&
    typeof message.extendedTextMessage === "object"
      ? (message.extendedTextMessage as { text?: string })
      : null;
  if (typeof message?.conversation === "string" && message.conversation) {
    return message.conversation;
  }
  if (typeof ext?.text === "string" && ext.text) return ext.text;
  if (typeof data?.body === "string" && data.body) return data.body;
  return "";
}

function extractMedia(payload: Record<string, unknown>): {
  hasMedia: boolean;
  url?: string | null;
  mimetype?: string | null;
  filename?: string | null;
} {
  const hasMedia = payload.hasMedia === true;
  const media =
    payload.media && typeof payload.media === "object"
      ? (payload.media as Record<string, unknown>)
      : null;
  const data =
    payload._data && typeof payload._data === "object"
      ? (payload._data as Record<string, unknown>)
      : null;
  const message =
    data?.Message && typeof data.Message === "object"
      ? (data.Message as Record<string, unknown>)
      : null;
  const isPtt = Boolean(message?.audioMessage || message?.pttMessage);
  let mimetype =
    typeof media?.mimetype === "string"
      ? media.mimetype
      : typeof media?.mime_type === "string"
        ? media.mime_type
        : null;
  if (!mimetype && isPtt) mimetype = "audio/ogg; codecs=opus";
  return {
    hasMedia: hasMedia || Boolean(media) || isPtt,
    url: typeof media?.url === "string" ? media.url : null,
    mimetype,
    filename: typeof media?.filename === "string" ? media.filename : null,
  };
}

function extractMessage(data: unknown): {
  id: string;
  text: string;
  chatId: string;
  fromMe: boolean;
  source?: string;
  media: ReturnType<typeof extractMedia>;
} | null {
  if (!data || typeof data !== "object") return null;
  const evt = data as Record<string, unknown>;
  const eventName = typeof evt.event === "string" ? evt.event : "";
  if (eventName && !eventName.includes("message")) return null;

  const payload =
    evt.payload && typeof evt.payload === "object"
      ? (evt.payload as Record<string, unknown>)
      : evt;

  const text =
    (typeof payload.body === "string" && payload.body) ||
    (typeof payload.text === "string" && payload.text) ||
    nestedText(payload) ||
    "";
  const id =
    (typeof payload.id === "string" && payload.id) ||
    (typeof evt.id === "string" && evt.id) ||
    "";
  const fromMe = payload.fromMe === true;
  const chatId =
    (typeof payload.from === "string" && payload.from) ||
    (typeof (payload as { chatId?: string }).chatId === "string" &&
      (payload as { chatId: string }).chatId) ||
    (fromMe && typeof payload.to === "string" && payload.to) ||
    "";
  const source =
    typeof payload.source === "string" ? payload.source : undefined;
  const media = extractMedia(payload);

  if (!chatId) return null;
  if (!text.trim() && !media.hasMedia) return null;
  return {
    id,
    text: text.trim(),
    chatId,
    fromMe,
    source,
    media,
  };
}

function isAudioMedia(media: ReturnType<typeof extractMedia>): boolean {
  const m = (media.mimetype || "").toLowerCase();
  return (
    media.hasMedia &&
    (m.startsWith("audio/") ||
      m.includes("ogg") ||
      m.includes("opus") ||
      m.includes("ptt"))
  );
}

async function handleEvent(raw: string) {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return;
  }

  const msg = extractMessage(data);
  if (!msg) return;

  try {
    const result = await routeInboundMessage({
      messageId: msg.id || `ws-${Date.now()}`,
      chatId: msg.chatId,
      text: msg.text,
      fromMe: msg.fromMe,
      source: msg.source,
      media: msg.media,
      hasMedia: isAudioMedia(msg.media) || msg.media.hasMedia,
    });
    if (!result.ignored) {
      console.log(
        `[waha-ws] ${result.action}${result.id ? ` ${result.id}` : ""} ← ${msg.chatId}`,
      );
    }
  } catch (err) {
    console.warn(
      "[waha-ws] handle failed:",
      err instanceof Error ? err.message : err,
    );
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, 5_000);
}

function connect() {
  if (process.env.VERCEL) return;
  if (process.env.DISABLE_WAHA_WS === "1") return;

  let url: string;
  try {
    const { baseUrl, apiKey, session } = getWahaServerConfig();
    const wsBase = baseUrl.replace(/^http/, "ws").replace(/\/$/, "");
    const params = new URLSearchParams();
    params.set("x-api-key", apiKey);
    params.set("session", session);
    params.append("events", "message.any");
    url = `${wsBase}/ws?${params.toString()}`;
  } catch (err) {
    console.warn(
      "[waha-ws] not configured:",
      err instanceof Error ? err.message : err,
    );
    return;
  }

  try {
    socket?.close();
  } catch {
    /* ignore */
  }

  try {
    socket = new WebSocket(url);
  } catch (err) {
    console.warn(
      "[waha-ws] open failed:",
      err instanceof Error ? err.message : err,
    );
    scheduleReconnect();
    return;
  }

  socket.addEventListener("open", () => {
    console.log("[waha-ws] connected — listening for snooze/commands");
  });

  socket.addEventListener("message", (event) => {
    const data =
      typeof event.data === "string"
        ? event.data
        : Buffer.isBuffer(event.data)
          ? event.data.toString("utf8")
          : String(event.data);
    void handleEvent(data);
  });

  socket.addEventListener("close", () => {
    socket = null;
    scheduleReconnect();
  });

  socket.addEventListener("error", () => {
    // close handler will reconnect
  });
}

/** Outbound WebSocket to WAHA so localhost can receive fromMe replies. */
export function startWahaEventListener() {
  if (started) return;
  if (process.env.VERCEL) return;
  if (process.env.DISABLE_WAHA_WS === "1") return;
  started = true;
  setTimeout(connect, 3_000);
}
