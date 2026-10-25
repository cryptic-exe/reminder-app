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
import { sendWhatsAppText } from "@/lib/waha";

export type PersonalInboxResult = {
  action: string;
  id?: string;
  ignored?: boolean;
};

function displayName(chatId: string, pushName?: string | null): string {
  if (pushName?.trim()) return pushName.trim();
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
 * Someone DMed the WAHA-linked number (acting as you).
 * Queue a reminder on your personal phone to reply, with context.
 * Does not reply in the DM thread.
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

  if (!(await claimMessageId(input.messageId))) {
    return { action: "create-dup", ignored: true };
  }
  const fp = `personal-dm:${input.chatId}:${text.slice(0, 120)}`;
  if (!(await claimFingerprint(fp))) {
    return { action: "create-dup", ignored: true };
  }

  const owner = await ensureOwnerTarget();
  if (!owner) {
    console.warn(
      "[personal-inbox] OWNER_NOTIFY_CHAT_ID not set — cannot queue reply reminder",
    );
    return { action: "no-owner-target", ignored: true };
  }

  const who = displayName(input.chatId, input.pushName);
  const snippet = text.length > 120 ? `${text.slice(0, 117)}…` : text;
  const title = `Reply to ${who}: ${snippet}`;
  const delayMin = getPersonalReplyDelayMinutes();
  const dueAt = new Date(Date.now() + delayMin * 60_000);

  const reminder = await prisma.reminder.create({
    data: {
      title,
      body: [
        `Incoming WhatsApp DM on your linked number.`,
        `From: ${who} (${input.chatId})`,
        `Message: ${text}`,
        `Open that chat and reply when this fires.`,
      ].join("\n"),
      dueAt,
      rawInput: `personal-dm: ${text}`,
      status: "pending",
      chatTargetId: owner.id,
      recurrenceType: "none",
      recurrenceWeekdays: [],
    },
  });

  // Quiet ack only on your phone — never in the other person's chat
  const dueLabel = formatInUserTz(dueAt.toISOString(), getUserTimezone());
  await sendWhatsAppText(
    `📥 Reply later\n${who}: ${snippet}\nRemind at: ${dueLabel}\nid:${reminder.id.slice(-6)}`,
    owner.chatId,
  ).catch(() => undefined);

  return { action: "personal-reply-reminder", id: reminder.id };
}
