import { prisma } from "@/lib/db";
import { claimFingerprint, claimMessageId } from "@/lib/inbound-dedupe";
import {
  ensureOwnerNotifyIdentities,
  getOwnerNotifyChatId,
  getPersonalReplyDelayMinutes,
  isOwnerNotifyChatAsync,
  isPersonalChat,
  normalizeChatId,
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

const OWNER_MODE_TTL_MS = 12 * 60 * 60_000;

function displayName(chatId: string, pushName?: string | null): string {
  if (pushName?.trim()) return pushName.trim();
  if (chatId.endsWith("@lid")) return chatId;
  const digits = chatId.replace(/@c\.us$/i, "").replace(/\D/g, "");
  if (digits.length >= 10) return `+${digits}`;
  return chatId;
}

function shortRef(id: string): string {
  return id.slice(-6);
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

async function getSessionMode(
  chatId: string,
): Promise<"ai" | "owner" | "ask" | null> {
  const row = await prisma.personalDmSession.findUnique({ where: { chatId } });
  if (!row) return null;
  if (row.mode === "owner") {
    const age = Date.now() - row.updatedAt.getTime();
    if (age > OWNER_MODE_TTL_MS) return null;
  }
  if (row.mode === "ai" || row.mode === "owner" || row.mode === "ask") {
    return row.mode;
  }
  return null;
}

async function setSessionMode(
  chatId: string,
  mode: "ai" | "owner" | "ask",
): Promise<void> {
  await prisma.personalDmSession.upsert({
    where: { chatId },
    create: { chatId, mode },
    update: { mode },
  });
}

async function sendAiReplyForItem(item: {
  id: string;
  chatId: string;
  text: string;
  pushName: string | null;
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
  await prisma.personalDmQueue.updateMany({
    where: {
      chatId: item.chatId,
      status: "awaiting_owner",
      id: { not: item.id },
    },
    data: { status: "skipped" },
  });
  await setSessionMode(item.chatId, "ai");

  const ownerChat = getOwnerNotifyChatId();
  if (ownerChat) {
    await sendWhatsAppText(
      `✅ AI → ${who}\nThem: ${snippet}\nBot: ${ai.reply.slice(0, 160)}\n(AI ON for this chat. Stop: AI OFF ${shortRef(item.id)})`,
      ownerChat,
    ).catch(() => undefined);
  }

  if (ai.needsHuman) {
    const owner = await ensureOwnerTarget();
    if (owner) {
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
  }

  return {
    action: "personal-ai-reply",
    id: item.id,
    reply: ai.reply,
    needsHuman: ai.needsHuman,
  };
}

async function askOwnerToDecide(item: {
  id: string;
  chatId: string;
  text: string;
  pushName: string | null;
}): Promise<PersonalInboxResult> {
  const ownerChat = getOwnerNotifyChatId();
  if (!ownerChat) {
    return { action: "personal-no-owner", id: item.id, ignored: true };
  }

  const who = displayName(item.chatId, item.pushName);
  const snippet =
    item.text.length > 200 ? `${item.text.slice(0, 197)}…` : item.text;
  const ref = shortRef(item.id);

  await setSessionMode(item.chatId, "ask");
  await sendWhatsAppText(
    [
      `📩 ${who}`,
      snippet,
      ``,
      `AI is conversation le?`,
      `YES ${ref} — AI baat continue karega`,
      `NO ${ref} — aap khud reply karo`,
    ].join("\n"),
    ownerChat,
  ).catch((err) => {
    console.warn(
      "[personal-inbox] owner ask failed:",
      err instanceof Error ? err.message : err,
    );
  });

  return { action: "personal-awaiting-owner", id: item.id };
}

/**
 * Personal DM on WAHA-linked number:
 * - If chat is AI-mode → reply now
 * - If chat is owner-mode → stay quiet (owner handles)
 * - Else → ask owner YES/NO whether AI should take over
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

  await ensureOwnerNotifyIdentities();

  // Owner phone (@c.us or @lid) → YES/NO handoff, never treat as customer DM
  if (await isOwnerNotifyChatAsync(input.chatId)) {
    return processOwnerHandoffDecision({
      messageId: input.messageId,
      text: input.text,
    });
  }

  const text = input.text.trim();
  if (!text) return { action: "ignored-empty", ignored: true };

  // Bare YES/NO from a non-customer path that slipped through — still handoff
  const maybeDecision = parseOwnerDecision(text);
  if (maybeDecision.decision) {
    // If this chat itself has awaiting_owner as customer, don't steal their "yes"
    const selfPending = await prisma.personalDmQueue.findFirst({
      where: { chatId: input.chatId, status: "awaiting_owner" },
    });
    if (!selfPending) {
      return processOwnerHandoffDecision({
        messageId: input.messageId,
        text: input.text,
      });
    }
  }

  const textKey = text.toLowerCase().replace(/\s+/g, " ").slice(0, 160);
  if (!(await claimFingerprint(`pdm:${textKey}`))) {
    return { action: "create-dup", ignored: true };
  }
  if (!(await claimMessageId(input.messageId))) {
    return { action: "create-dup", ignored: true };
  }

  const mode = await getSessionMode(input.chatId);

  if (mode === "owner") {
    const ownerChat = getOwnerNotifyChatId();
    if (ownerChat) {
      const who = displayName(input.chatId, input.pushName);
      await sendWhatsAppText(
        `📩 ${who} (aap handle kar rahe ho)\n${text.slice(0, 200)}`,
        ownerChat,
      ).catch(() => undefined);
    }
    return { action: "personal-owner-mode", ignored: true };
  }

  const row = await prisma.personalDmQueue.create({
    data: {
      messageId: input.messageId,
      chatId: input.chatId,
      text,
      pushName: input.pushName?.trim() || null,
      receivedAt: new Date(),
      replyAfter: new Date(),
      status: mode === "ai" ? "awaiting_owner" : "awaiting_owner",
    },
  });

  if (mode === "ai") {
    return sendAiReplyForItem(row);
  }

  return askOwnerToDecide(row);
}

function parseOwnerDecision(text: string): {
  decision: "yes" | "no" | "ai_off" | null;
  ref: string | null;
} {
  const t = text.trim().toLowerCase().replace(/\s+/g, " ");
  const refMatch = t.match(/\b([a-z0-9]{4,8})\s*$/i);
  const ref = refMatch?.[1] && !/^(yes|no|haan|han|na|ai|off|on)$/i.test(refMatch[1])
    ? refMatch[1]
    : null;

  if (/^(ai\s*off|stop\s*ai)\b/.test(t)) {
    return { decision: "ai_off", ref };
  }
  if (
    /^(yes|y|haan|han|ha|ai(\s+yes)?|ok\s*ai)\b/.test(t) ||
    /^yes\b/.test(t)
  ) {
    return { decision: "yes", ref };
  }
  if (/^(no|n|na|nahi|owner|main|me)\b/.test(t)) {
    return { decision: "no", ref };
  }
  return { decision: null, ref: null };
}

async function findQueueForDecision(ref: string | null) {
  const ownerIds = new Set(
    (await ensureOwnerNotifyIdentities()).map(normalizeChatId),
  );

  const notOwner = (chatId: string) => !ownerIds.has(normalizeChatId(chatId));

  if (ref) {
    const matches = (
      await prisma.personalDmQueue.findMany({
        where: {
          status: "awaiting_owner",
          id: { endsWith: ref },
        },
        orderBy: { createdAt: "desc" },
        take: 10,
      })
    ).filter((m) => notOwner(m.chatId));
    if (matches.length >= 1) {
      return matches.find((m) => m.id.endsWith(ref)) ?? matches[0];
    }
  }

  // Prefer real customer DMs — never the owner's own YES/NO echoed as queue rows
  const pending = await prisma.personalDmQueue.findMany({
    where: { status: "awaiting_owner" },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  return pending.find((m) => notOwner(m.chatId)) ?? null;
}

/**
 * Owner (NOTIFY phone) replies YES/NO to hand conversation to AI.
 */
export async function processOwnerHandoffDecision(input: {
  messageId: string;
  text: string;
}): Promise<PersonalInboxResult> {
  const text = input.text.trim();
  if (!text) return { action: "ignored-empty", ignored: true };

  if (!(await claimMessageId(input.messageId))) {
    return { action: "create-dup", ignored: true };
  }

  const { decision, ref } = parseOwnerDecision(text);
  const ownerChat = getOwnerNotifyChatId();

  if (!decision) {
    return { action: "owner-ignored", ignored: true };
  }

  if (decision === "ai_off") {
    const item = await findQueueForDecision(ref);
    const chatId = item?.chatId;
    if (chatId) {
      await setSessionMode(chatId, "owner");
      await prisma.personalDmQueue.updateMany({
        where: { chatId, status: "awaiting_owner" },
        data: { status: "skipped" },
      });
    } else {
      // Turn off AI for most recent AI session
      const recent = await prisma.personalDmSession.findFirst({
        where: { mode: "ai" },
        orderBy: { updatedAt: "desc" },
      });
      if (recent) await setSessionMode(recent.chatId, "owner");
    }
    if (ownerChat) {
      await sendWhatsAppText(
        "OK — AI OFF. Aap khud reply karo. Phir se AI ke liye naya DM aaye to YES bhejna.",
        ownerChat,
      ).catch(() => undefined);
    }
    return { action: "personal-ai-off", id: chatId };
  }

  const item = await findQueueForDecision(ref);
  if (!item) {
    if (ownerChat) {
      await sendWhatsAppText(
        "Koi pending DM nahi mili. Naya message aaye to YES/NO bhejna.",
        ownerChat,
      ).catch(() => undefined);
    }
    return { action: "personal-no-pending", ignored: true };
  }

  if (decision === "no") {
    await setSessionMode(item.chatId, "owner");
    await prisma.personalDmQueue.update({
      where: { id: item.id },
      data: { status: "skipped" },
    });
    await prisma.personalDmQueue.updateMany({
      where: { chatId: item.chatId, status: "awaiting_owner" },
      data: { status: "skipped" },
    });
    if (ownerChat) {
      await sendWhatsAppText(
        `OK — aap reply karo (${displayName(item.chatId, item.pushName)}). AI quiet rahega.`,
        ownerChat,
      ).catch(() => undefined);
    }
    return { action: "personal-owner-will-reply", id: item.id };
  }

  // YES — AI takes over
  return sendAiReplyForItem(item);
}

/** @deprecated Delay path removed; kept so cron/webhook imports don't break. */
export async function processDuePersonalDmReplies(): Promise<{
  checked: number;
  results: PersonalInboxResult[];
}> {
  return { checked: 0, results: [] };
}
