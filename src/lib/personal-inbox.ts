import { prisma } from "@/lib/db";
import { claimFingerprint, claimMessageId } from "@/lib/inbound-dedupe";
import {
  getOwnerNotifyChatId,
  getPersonalDmAiDelayMinutes,
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
  if (chatId.endsWith("@lid")) return chatId;
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
 * Queue a personal DM for delayed AI reply.
 * AI waits PERSONAL_DM_AI_DELAY_MINUTES (default 5). If Deepak replies first → skip.
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

  const textKey = text.toLowerCase().replace(/\s+/g, " ").slice(0, 160);
  if (!(await claimFingerprint(`pdm:${textKey}`))) {
    return { action: "create-dup", ignored: true };
  }
  if (!(await claimMessageId(input.messageId))) {
    return { action: "create-dup", ignored: true };
  }

  const delayMin = getPersonalDmAiDelayMinutes();
  const receivedAt = new Date();
  const replyAfter = new Date(receivedAt.getTime() + delayMin * 60_000);

  const row = await prisma.personalDmQueue.create({
    data: {
      messageId: input.messageId,
      chatId: input.chatId,
      text,
      pushName: input.pushName?.trim() || null,
      receivedAt,
      replyAfter,
      status: "pending",
    },
  });

  return {
    action: "personal-ai-queued",
    id: row.id,
  };
}

async function deepakAlreadyReplied(
  chatId: string,
  after: Date,
): Promise<boolean> {
  const msgs = await fetchChatMessages(chatId, 30).catch(() => []);
  const afterSec = Math.floor(after.getTime() / 1000) - 5;
  return msgs.some(
    (m) =>
      m.fromMe &&
      m.body.trim() &&
      m.timestamp >= afterSec &&
      // Ignore our own AI/owner-notify style lines if timestamp clock skew
      !m.body.startsWith("✅ AI replied") &&
      !m.body.startsWith("🤝 Needs you"),
  );
}

async function sendAiReplyForQueueItem(item: {
  id: string;
  chatId: string;
  text: string;
  pushName: string | null;
  receivedAt: Date;
}): Promise<PersonalInboxResult> {
  const who = displayName(item.chatId, item.pushName);
  const snippet =
    item.text.length > 120 ? `${item.text.slice(0, 117)}…` : item.text;

  const history = await fetchChatMessages(item.chatId, 16)
    .then((msgs) =>
      [...msgs]
        .reverse()
        .filter((m) => m.body.trim())
        .filter((m) => m.body.trim() !== item.text)
        .slice(-8)
        .map((m) => ({ fromMe: m.fromMe, text: m.body.trim() })),
    )
    .catch(() => [] as Array<{ fromMe: boolean; text: string }>);

  // Opening = little/no prior outbound from this number in recent history
  const priorFromUs = history.some((h) => h.fromMe);
  const isOpening = !priorFromUs;

  const ai = await generatePersonalDmReply({
    text: item.text,
    fromName: who,
    history,
    isOpening,
  });

  await sendWhatsAppText(ai.reply, item.chatId).catch((err) => {
    console.warn(
      "[personal-inbox] reply send failed:",
      err instanceof Error ? err.message : err,
    );
  });

  await prisma.personalDmQueue.update({
    where: { id: item.id },
    data: { status: "replied" },
  });

  // Collapse other pending items in this chat (one AI turn is enough)
  await prisma.personalDmQueue.updateMany({
    where: {
      chatId: item.chatId,
      status: "pending",
      id: { not: item.id },
    },
    data: { status: "skipped" },
  });

  if (!ai.needsHuman) {
    const ownerChat = getOwnerNotifyChatId();
    if (ownerChat) {
      await sendWhatsAppText(
        `✅ AI replied to ${who}\nThem: ${snippet}\nBot: ${ai.reply.slice(0, 160)}`,
        ownerChat,
      ).catch(() => undefined);
    }
    return {
      action: "personal-ai-reply",
      id: item.id,
      reply: ai.reply,
      needsHuman: false,
    };
  }

  const owner = await ensureOwnerTarget();
  if (!owner) {
    return {
      action: "personal-ai-fallback",
      id: item.id,
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
        `From: ${who} (${item.chatId})`,
        `Message: ${item.text}`,
        `AI said: ${ai.reply}`,
      ].join("\n"),
      dueAt,
      rawInput: `personal-dm: ${item.text}`,
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

/**
 * Cron: after the delay window, AI replies only if Deepak hasn't answered yet.
 */
export async function processDuePersonalDmReplies(): Promise<{
  checked: number;
  results: PersonalInboxResult[];
}> {
  const now = new Date();
  const due = await prisma.personalDmQueue.findMany({
    where: { status: "pending", replyAfter: { lte: now } },
    orderBy: { replyAfter: "asc" },
    take: 20,
  });

  const results: PersonalInboxResult[] = [];
  const seenChats = new Set<string>();

  for (const item of due) {
    if (seenChats.has(item.chatId)) {
      await prisma.personalDmQueue.update({
        where: { id: item.id },
        data: { status: "skipped" },
      });
      results.push({ action: "personal-ai-skipped-batch", id: item.id, ignored: true });
      continue;
    }
    seenChats.add(item.chatId);

    try {
      if (await deepakAlreadyReplied(item.chatId, item.receivedAt)) {
        await prisma.personalDmQueue.update({
          where: { id: item.id },
          data: { status: "skipped" },
        });
        await prisma.personalDmQueue.updateMany({
          where: { chatId: item.chatId, status: "pending" },
          data: { status: "skipped" },
        });
        results.push({
          action: "personal-ai-skipped-human",
          id: item.id,
          ignored: true,
        });
        continue;
      }

      const result = await sendAiReplyForQueueItem(item);
      results.push(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await prisma.personalDmQueue
        .update({
          where: { id: item.id },
          data: { status: "failed", lastError: message.slice(0, 500) },
        })
        .catch(() => undefined);
      results.push({ action: "personal-ai-failed", id: item.id });
      console.warn("[personal-inbox] due reply failed:", message);
    }
  }

  return { checked: due.length, results };
}
