import { getReminderGroupChatId } from "@/lib/chat-routing";
import { claimMessageId } from "@/lib/inbound-dedupe";
import {
  routeInboundMessage,
  routePolledGroupCommand,
} from "@/lib/inbound-router";
import { fetchChatMessages } from "@/lib/waha";

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
 * Poll the reminder group for commands/voice.
 * Personal DMs are handled via WAHA webhook (not polled).
 */
export async function pollInboundWhatsApp(): Promise<{
  checked: number;
  handled: Array<{ chatId: string; action: string; id?: string }>;
}> {
  const handled: Array<{ chatId: string; action: string; id?: string }> = [];
  const groupId = getReminderGroupChatId();
  if (!groupId) {
    return { checked: 0, handled };
  }

  const since = Math.floor(Date.now() / 1000) - 30 * 60;
  let checked = 0;

  let messages;
  try {
    messages = await fetchChatMessages(groupId, 20, true);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[inbound-poll] fetch ${groupId} failed:`, msg.slice(0, 200));
    return { checked: 0, handled };
  }

  const chronological = [...messages].reverse();
  for (const m of chronological) {
    checked += 1;
    if (m.timestamp < since) continue;
    if (m.source === "api") continue;

    if (isAudio(m) && m.media?.url) {
      if (!(await claimMessageId(m.id))) continue;
      try {
        const result = await routeInboundMessage({
          messageId: m.id,
          chatId: groupId,
          text: m.body || "",
          fromMe: m.fromMe,
          source: m.source,
          media: m.media,
          hasMedia: true,
        });
        if (!result.ignored) {
          handled.push({ chatId: groupId, action: result.action, id: result.id });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[inbound-poll] voice failed:`, msg.slice(0, 200));
      }
      continue;
    }

    if (!m.body) continue;
    try {
      const result = await routePolledGroupCommand({
        messageId: m.id,
        chatId: groupId,
        text: m.body,
        source: m.source,
      });
      if (!result.ignored) {
        handled.push({
          chatId: groupId,
          action: result.action,
          id: result.id,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[inbound-poll] handle failed:`, msg.slice(0, 200));
    }
  }

  return { checked, handled };
}
