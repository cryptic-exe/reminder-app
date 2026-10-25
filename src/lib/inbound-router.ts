import {
  isBotEcho,
  looksLikeUserCommand,
  processInboundText,
  type InboundResult,
} from "@/lib/inbound";
import { processInboundVoice } from "@/lib/inbound-voice";
import { processPersonalDm } from "@/lib/personal-inbox";
import {
  isPersonalChat,
  isReminderGroupChat,
} from "@/lib/chat-routing";
import { claimFingerprint, claimMessageId } from "@/lib/inbound-dedupe";

export type RoutedMedia = {
  url?: string | null;
  mimetype?: string | null;
  filename?: string | null;
};

/**
 * Single entry for webhook / poll / local WS.
 * - Reminder group → remind / snooze / list / voice
 * - Personal DM to linked WAHA number (!fromMe) → reply-later reminder to owner phone
 * - Everything else → ignore
 */
export async function routeInboundMessage(input: {
  messageId: string;
  chatId: string;
  text: string;
  fromMe: boolean;
  source?: string;
  pushName?: string | null;
  media?: RoutedMedia | null;
  hasMedia?: boolean;
}): Promise<InboundResult> {
  const chatId = input.chatId.trim();
  if (!chatId) return { action: "ignored", ignored: true };

  const mime = (input.media?.mimetype || "").toLowerCase();
  const isAudio =
    (input.hasMedia || Boolean(input.media)) &&
    (mime.startsWith("audio/") ||
      mime.includes("ogg") ||
      mime.includes("opus") ||
      mime.includes("ptt"));

  // ——— Reminder group only for bot commands / voice reminders ———
  if (isReminderGroupChat(chatId)) {
    if (isAudio && input.media?.url && input.source !== "api") {
      return processInboundVoice({
        messageId: input.messageId,
        chatId,
        caption: input.text || null,
        media: input.media,
      });
    }

    const text = input.text.trim();
    if (!text || isBotEcho(text)) return { action: "ignored", ignored: true };
    if (!looksLikeUserCommand(text)) {
      return { action: "ignored", ignored: true };
    }
    // Claim before create — webhook can fire message + retries concurrently
    if (!(await claimMessageId(input.messageId))) {
      return { action: "create-dup", ignored: true };
    }
    if (!(await claimFingerprint(`group:${chatId}:${text}`))) {
      return { action: "create-dup", ignored: true };
    }
    return processInboundText(text, chatId);
  }

  // ——— Personal inbox on linked number: queue "reply later" for you ———
  if (
    isPersonalChat(chatId) &&
    !input.fromMe &&
    input.source !== "api"
  ) {
    const text = input.text.trim();
    if (!text || isBotEcho(text)) return { action: "ignored", ignored: true };
    return processPersonalDm({
      messageId: input.messageId,
      chatId,
      text,
      pushName: input.pushName,
    });
  }

  return { action: "ignored", ignored: true };
}

/** Poll helper: claim + route text commands in the reminder group only. */
export async function routePolledGroupCommand(input: {
  messageId: string;
  chatId: string;
  text: string;
  source?: string;
}): Promise<InboundResult> {
  if (!isReminderGroupChat(input.chatId)) {
    return { action: "ignored", ignored: true };
  }
  const text = input.text.trim();
  if (!text || isBotEcho(text) || !looksLikeUserCommand(text)) {
    return { action: "ignored", ignored: true };
  }
  if (!(await claimMessageId(input.messageId))) {
    return { action: "create-dup", ignored: true };
  }
  if (!(await claimFingerprint(text))) {
    return { action: "create-dup", ignored: true };
  }
  return processInboundText(text, input.chatId);
}
