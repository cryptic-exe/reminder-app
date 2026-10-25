import { prisma } from "@/lib/db";
import { claimFingerprint, claimMessageId } from "@/lib/inbound-dedupe";
import {
  getOwnerNotifyChatId,
  getPersonalReplyDelayMinutes,
  isOwnerNotifyChat,
  isPersonalChat,
} from "@/lib/chat-routing";
import { formatInUserTz } from "@/lib/time";
import { getUserTimezone } from "@/lib/env";
import { generatePersonalDmReply } from "@/lib/llm/dm-reply";
import { fetchChatMessages, sendWhatsAppText } from "@/lib/waha";

export type PersonalInboxResult = {
  action: string;
  id?: string;
  ignored?: boolean;
  reply?: string;
  needsHuman?: boolean;
};

function displayName(chatId: string, pushName?: string | null): string {
  if (pushName?.trim()) return pushName.trim();
  if (chatId.endsWith("@lid")) return chatId; // hidden WhatsApp id
  const digits = chatId.replace(/@c\.us$/i, "").replace(/\D/g, "");
  if (digits.length >= 10) return `+${digits}`;
  return chatId;
}

async function ensureOwnerTarget(): Promise<{ id: string; chatId: string } | null> {
  const chatId = getOwnerNotifyChatId();
  if (!chatId) return null;
  const existing = await prisma.chatTarget.findFirst({ where: { chatId } });
  if (existing) return { id: existing.id, chatId };
  const created = await prisma.chatTarget.create({
    data: { name: "Me (notify)", chatId, isDefault: false },
  });
  return { id: created.id, chatId };
}

/**
 * Personal DM on the WAHA-linked number:
 * 1) AI reads the message and replies in-thread
 * 2) If unsure → "I'm an AI — Deepak will get back to you."
 * 3) When human follow-up is needed → reminder on OWNER_NOTIFY_CHAT_ID
 */
export async function processPersonalDm(input: {
  messageId: string;
  chatId: string;
  text: string;
  pushName?: string | null;
}): Promise<PersonalInboxResult> {
  if (!isPersonalChat(input.chatId)) {
    return { action: "ignored", ignored: true };
  }
  if (isOwnerNotifyChat(input.chatId)) {
    return { action: "ignored-owner", ignored: true };
  }

  const text = input.text.trim();
  if (!text) return { action: "ignored-empty", ignored: true };

  // Text-only fingerprint (no chatId): same DM can arrive as @lid and @c.us.
  // Claim before LLM so concurrent webhook + local WS cannot both reply.
  const textKey = text.toLowerCase().replace(/\s+/g, " ").slice(0, 160);
  if (!(await claimFingerprint(`pdm:${textKey}`))) {
    return { action: "create-dup", ignored: true };
  }
  if (!(await claimMessageId(input.messageId))) {
    return { action: "create-dup", ignored: true };
  }

  const who = displayName(input.chatId, input.pushName);
  const snippet = text.length > 120 ? `${text.slice(0, 117)}…` : text;

  // Recent turns so the bot continues the chat instead of restarting every message
  const history = await fetchChatMessages(input.chatId, 12)
    .then((msgs) =>
      [...msgs]
        .reverse()
        .filter((m) => m.body.trim())
        .filter((m) => m.body.trim() !== text)
        .slice(-8)
        .map((m) => ({ fromMe: m.fromMe, text: m.body.trim() })),
    )
    .catch(() => [] as Array<{ fromMe: boolean; text: string }>);

  const ai = await generatePersonalDmReply({ text, fromName: who, history });

  // Reply in the same personal chat (acting on Deepak's linked number)
  await sendWhatsAppText(ai.reply, input.chatId).catch((err) => {
    console.warn(
      "[personal-inbox] reply send failed:",
      err instanceof Error ? err.message : err,
    );
  });

  if (!ai.needsHuman) {
    // Optional light notify — AI handled it
    const ownerChat = getOwnerNotifyChatId();
    if (ownerChat) {
      await sendWhatsAppText(
        `✅ AI replied to ${who}\nThem: ${snippet}\nBot: ${ai.reply.slice(0, 160)}`,
        ownerChat,
      ).catch(() => undefined);
    }
    return {
      action: "personal-ai-reply",
      reply: ai.reply,
      needsHuman: false,
    };
  }

  // Needs Deepak — queue reminder on personal phone
  const owner = await ensureOwnerTarget();
  if (!owner) {
    return {
      action: "personal-ai-fallback",
      reply: ai.reply,
      needsHuman: true,
    };
  }

  const delayMin = getPersonalReplyDelayMinutes();
  const dueAt = new Date(Date.now() + delayMin * 60_000);
  const reminder = await prisma.reminder.create({
    data: {
      title: `Reply to ${who}: ${snippet}`,
      body: [
        `AI could not fully answer — follow up needed.`,
        `From: ${who} (${input.chatId})`,
        `Message: ${text}`,
        `AI said: ${ai.reply}`,
      ].join("\n"),
      dueAt,
      rawInput: `personal-dm: ${text}`,
      status: "pending",
      chatTargetId: owner.id,
      recurrenceType: "none",
      recurrenceWeekdays: [],
    },
  });

  const dueLabel = formatInUserTz(dueAt.toISOString(), getUserTimezone());
  await sendWhatsAppText(
    `🤝 Needs you\n${who}: ${snippet}\nAI: ${ai.reply}\nRemind: ${dueLabel}\nid:${reminder.id.slice(-6)}`,
    owner.chatId,
  ).catch(() => undefined);

  return {
    action: "personal-ai-needs-human",
    id: reminder.id,
    reply: ai.reply,
    needsHuman: true,
  };
}
