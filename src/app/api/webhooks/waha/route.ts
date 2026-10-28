import { NextResponse } from "next/server";
import {
  isWatchedInboundChat,
  normalizeChatId,
} from "@/lib/chat-routing";
import { getWebhookSecret } from "@/lib/env";
import { routeInboundMessage } from "@/lib/inbound-router";
import { processDuePersonalDmReplies } from "@/lib/personal-inbox";

export const maxDuration = 60;

function authorized(request: Request): boolean {
  try {
    const secret = getWebhookSecret();
    const header = request.headers.get("authorization");
    if (header === `Bearer ${secret}`) return true;
    const url = new URL(request.url);
    if (url.searchParams.get("secret") === secret) return true;
    if (request.headers.get("x-api-key") === secret) return true;
    return false;
  } catch {
    return false;
  }
}

function extractPayload(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== "object") return null;
  const p = body as Record<string, unknown>;
  if (p.payload && typeof p.payload === "object") {
    return p.payload as Record<string, unknown>;
  }
  return p;
}

/** Prefer payload.from (may be @lid); fall back to chatId / to / _data.Info.Chat */
function extractChatId(
  payload: Record<string, unknown>,
  fromMe: boolean,
): string {
  const candidates = [
    typeof payload.from === "string" ? payload.from : "",
    typeof payload.chatId === "string" ? payload.chatId : "",
    fromMe && typeof payload.to === "string" ? payload.to : "",
  ];
  const data =
    payload._data && typeof payload._data === "object"
      ? (payload._data as Record<string, unknown>)
      : null;
  const info =
    data?.Info && typeof data.Info === "object"
      ? (data.Info as Record<string, unknown>)
      : null;
  if (typeof info?.Chat === "string") candidates.push(info.Chat);
  if (typeof info?.Sender === "string" && !fromMe) candidates.push(info.Sender);

  for (const raw of candidates) {
    if (!raw?.trim()) continue;
    return normalizeChatId(raw);
  }
  return "";
}

export async function POST(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const payload = extractPayload(body);
  if (!payload) {
    return NextResponse.json({ ok: true, ignored: true });
  }

  const fromMe = payload.fromMe === true;
  const chatId = extractChatId(payload, fromMe);

  // Drop other groups / status / channels before routing or DM drain.
  // (WAHA cannot allowlist a single group; engine ignore covers type-level only.)
  if (!isWatchedInboundChat(chatId)) {
    return NextResponse.json({
      ok: true,
      ignored: true,
      reason: "unwatched-chat",
      chatId,
    });
  }

  const text =
    (typeof payload.body === "string" && payload.body) ||
    (typeof payload.text === "string" && payload.text) ||
    "";
  const id = typeof payload.id === "string" ? payload.id : `wh-${Date.now()}`;
  const pushName =
    typeof payload.notifyName === "string"
      ? payload.notifyName
      : typeof payload.pushName === "string"
        ? payload.pushName
        : null;
  const media =
    payload.media && typeof payload.media === "object"
      ? (payload.media as {
          url?: string;
          mimetype?: string;
          filename?: string;
        })
      : null;
  const hasMedia = payload.hasMedia === true || Boolean(media);
  const source = typeof payload.source === "string" ? payload.source : undefined;

  try {
    const result = await routeInboundMessage({
      messageId: id,
      chatId,
      text,
      fromMe,
      source,
      pushName,
      media,
      hasMedia,
    });

    // GitHub Actions minute cron is often delayed — also drain due AI DMs here
    // whenever watched WhatsApp traffic hits us.
    const personalDm = await processDuePersonalDmReplies().catch((err) => {
      console.warn(
        "[webhook] personal DM drain failed:",
        err instanceof Error ? err.message : err,
      );
      return null;
    });

    return NextResponse.json({
      ok: true,
      ...result,
      fromMe,
      chatId,
      personalDm,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    hint: "POST WAHA message.any — reminder group + personal DMs only (other groups dropped)",
  });
}
