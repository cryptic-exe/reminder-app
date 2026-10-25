import { prisma } from "@/lib/db";
import { getWahaConfig } from "@/lib/env";
import { claimFingerprint, claimMessageId } from "@/lib/inbound-dedupe";
import {
  isBotEcho,
  looksLikeUserCommand,
  processInboundText,
} from "@/lib/inbound";
import { processInboundVoice } from "@/lib/inbound-voice";
import { fetchChatMessages } from "@/lib/waha";

async function targetChatIds(): Promise<string[]> {
  const { chatId: envChatId } = getWahaConfig();
  const targets = await prisma.chatTarget.findMany({
    select: { chatId: true },
  });
  const ids = new Set<string>();
  if (envChatId) ids.add(envChatId);
  for (const t of targets) ids.add(t.chatId);
  return [...ids];
}

function isAudio(m: {
  hasMedia?: boolean;
  media?: { mimetype?: string | null } | null;
}): boolean {
  const mime = (m.media?.mimetype || "").toLowerCase();
  return Boolean(
    m.hasMedia &&
      (mime.startsWith("audio/") ||
        mime.includes("ogg") ||
        mime.includes("opus")),
  );
}

/**
 * Pull recent WhatsApp messages from WAHA and run command handlers.
 * Backup when WebSocket misses events (e.g. voice from a non-linked phone).
 */
export async function pollInboundWhatsApp(): Promise<{
  checked: number;
  handled: Array<{ chatId: string; action: string; id?: string }>;
}> {
  const handled: Array<{ chatId: string; action: string; id?: string }> = [];
  const chatIds = await targetChatIds();
  if (chatIds.length === 0) {
    return { checked: 0, handled };
  }

  // Wide enough for Hobby cron + GitHub Actions minute lag (was 90s — too tight)
  const since = Math.floor(Date.now() / 1000) - 30 * 60;
  let checked = 0;

  for (const chatId of chatIds) {
    let messages;
    try {
      messages = await fetchChatMessages(chatId, 20, true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[inbound-poll] fetch ${chatId} failed:`, msg.slice(0, 200));
      continue;
    }

    const chronological = [...messages].reverse();
    for (const m of chronological) {
      checked += 1;
      if (m.timestamp < since) continue;
      if (m.source === "api") continue;

      if (isAudio(m) && m.media?.url) {
        if (!(await claimMessageId(m.id))) continue;
        try {
          const result = await processInboundVoice({
            messageId: m.id,
            chatId,
            caption: m.body || null,
            media: m.media,
          });
          if (!result.ignored) {
            handled.push({ chatId, action: result.action, id: result.id });
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[inbound-poll] voice failed:`, msg.slice(0, 200));
        }
        continue;
      }

      if (!m.body || isBotEcho(m.body) || !looksLikeUserCommand(m.body)) continue;
      if (
        !/^(snooze|list|cancel|stop|remind|reminder|schedule|\d{1,2})/i.test(
          m.body.trim(),
        ) &&
        !/^(?:at|on)?\s*\d{1,2}/i.test(m.body.trim())
      ) {
        continue;
      }

      if (!(await claimMessageId(m.id))) continue;
      if (!(await claimFingerprint(m.body))) continue;

      try {
        const result = await processInboundText(m.body, chatId);
        if (!result.ignored) {
          handled.push({
            chatId,
            action: result.action,
            id: result.id,
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[inbound-poll] handle failed:`, msg.slice(0, 200));
      }
    }
  }

  return { checked, handled };
}
