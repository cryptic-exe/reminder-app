import { NextResponse } from "next/server";
import { getWebhookSecret } from "@/lib/env";
import {
  isBotEcho,
  looksLikeUserCommand,
  processInboundText,
} from "@/lib/inbound";
import { processInboundVoice } from "@/lib/inbound-voice";

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
  const from =
    (typeof payload.from === "string" && payload.from) ||
    (fromMe && typeof payload.to === "string" && payload.to) ||
    "";
  const text =
    (typeof payload.body === "string" && payload.body) ||
    (typeof payload.text === "string" && payload.text) ||
    "";
  const id = typeof payload.id === "string" ? payload.id : `wh-${Date.now()}`;
  const media =
    payload.media && typeof payload.media === "object"
      ? (payload.media as {
          url?: string;
          mimetype?: string;
          filename?: string;
        })
      : null;
  const hasMedia = payload.hasMedia === true || Boolean(media);
  const mime = (media?.mimetype || "").toLowerCase();
  const isAudio =
    hasMedia &&
    (mime.startsWith("audio/") ||
      mime.includes("ogg") ||
      mime.includes("opus"));

  if (fromMe && isAudio && from) {
    if (payload.source === "api") {
      return NextResponse.json({ ok: true, ignored: true });
    }
    try {
      const result = await processInboundVoice({
        messageId: id,
        chatId: from,
        caption: text || null,
        media: {
          url: media?.url,
          mimetype: media?.mimetype,
          filename: media?.filename,
        },
      });
      return NextResponse.json({ ok: true, ...result, fromMe: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return NextResponse.json({ ok: false, error: message }, { status: 500 });
    }
  }

  if (!text.trim() || !from) {
    return NextResponse.json({ ok: true, ignored: true });
  }
  if (isBotEcho(text)) {
    return NextResponse.json({ ok: true, ignored: true });
  }
  if (fromMe && !looksLikeUserCommand(text)) {
    return NextResponse.json({ ok: true, ignored: true });
  }

  try {
    const result = await processInboundText(text.trim(), from);
    return NextResponse.json({ ok: true, ...result, fromMe });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    hint: "POST WAHA message.any events (text + voice notes)",
  });
}
