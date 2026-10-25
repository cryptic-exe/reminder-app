import { prisma } from "@/lib/db";
import { claimFingerprint } from "@/lib/inbound-dedupe";
import { parseReminderLocally } from "@/lib/llm/local-parse";
import { parseReminderWithLlm } from "@/lib/llm/router";
import { findReminderByShortId, snoozeReminder } from "@/lib/dispatch";
import {
  extractPhoneTarget,
  titleFromPhoneTask,
} from "@/lib/phone-target";
import { formatInUserTz } from "@/lib/time";
import { getUserTimezone } from "@/lib/env";
import { sendWhatsAppText } from "@/lib/waha";

async function resolveChatTargetId(
  targetHint: string | null | undefined,
  inboundChatId: string,
): Promise<{ id: string | null; label: string | null }> {
  const phone =
    targetHint && /^\d{10,15}$/.test(targetHint.replace(/\D/g, ""))
      ? targetHint.replace(/\D/g, "")
      : null;
  const fromHintPhone = phone
    ? phone.length === 10
      ? `91${phone}`
      : phone
    : null;

  if (fromHintPhone) {
    const chatId = `${fromHintPhone}@c.us`;
    const existing = await prisma.chatTarget.findFirst({ where: { chatId } });
    if (existing) return { id: existing.id, label: existing.name };
    const created = await prisma.chatTarget.create({
      data: { name: fromHintPhone, chatId, isDefault: false },
    });
    return { id: created.id, label: created.name };
  }

  if (targetHint) {
    const hint = targetHint.toLowerCase();
    const target = await prisma.chatTarget.findFirst({
      where: { name: { contains: hint, mode: "insensitive" } },
    });
    if (target) return { id: target.id, label: target.name };
  }

  const byChat = await prisma.chatTarget.findFirst({
    where: { chatId: inboundChatId },
  });
  if (byChat) return { id: byChat.id, label: byChat.name };
  const def = await prisma.chatTarget.findFirst({ where: { isDefault: true } });
  return { id: def?.id ?? null, label: def?.name ?? null };
}

export type InboundResult = {
  action: string;
  id?: string;
  dueAt?: Date;
  ignored?: boolean;
};

/** Bot / system echoes — never treat as user commands. */
export function isBotEcho(text: string): boolean {
  const t = text.trim();
  return (
    t.startsWith("⏰ Reminder:") ||
    t.startsWith("Snoozed ") ||
    t.startsWith("Cancelled ") ||
    t.startsWith("Saved:") ||
    t.startsWith("No recent reminder") ||
    t.startsWith("No reminder found") ||
    t.startsWith("Could not parse") ||
    t.startsWith("No upcoming reminders") ||
    t.startsWith("I'm an AI") ||
    t.startsWith("Main Deepak ka AI") ||
    t.startsWith("✅ AI replied") ||
    t.startsWith("🤝 Needs you")
  );
}

/**
 * Commands we accept from the linked phone (fromMe=true).
 * Keep this strict — otherwise every group message you send becomes a reminder.
 */
export function looksLikeUserCommand(text: string): boolean {
  const lower = text.trim().toLowerCase();
  if (!lower || isBotEcho(text)) return false;
  if (/^snooze\b/.test(lower)) return true;
  if (/^(list|cancel|stop)\b/.test(lower)) return true;
  if (/^(remind(\s+me)?|reminder|schedule)\b/.test(lower)) return true;
  // "remind to drink water…", "remind 9198XXXXXXXX to …"
  if (/^remind(?:er)?\s+(to\b|\+?\d)/.test(lower)) return true;
  // Bare time follow-up after a voice note: "11:38PM" / "at 11:38 pm"
  if (looksLikeTimeOnly(lower)) return true;
  return false;
}

/** "11:38PM", "11.38pm", "at 5", "on 5:30 pm" */
export function looksLikeTimeOnly(text: string): boolean {
  const t = text.trim().toLowerCase();
  return /^(?:at|on)?\s*\d{1,2}(?:[.:]\d{2})?\s*(?:am|pm)$/.test(t);
}

function formatDue(dueAt: Date): string {
  return formatInUserTz(dueAt.toISOString(), getUserTimezone());
}

async function findRecentReminder(shortId?: string | null) {
  if (shortId) {
    const byId = await findReminderByShortId(shortId);
    if (byId) return byId;
  }
  return prisma.reminder.findFirst({
    where: { status: { in: ["sent", "failed", "pending", "sending"] } },
    orderBy: [{ sentAt: "desc" }, { createdAt: "desc" }],
  });
}

/**
 * Handle a WhatsApp inbound text (webhook or poll).
 * `chatId` is the chat to reply in (group or DM).
 */
export async function processInboundText(
  text: string,
  chatId: string,
): Promise<InboundResult> {
  const trimmed = text.trim();
  if (!trimmed || isBotEcho(trimmed)) {
    return { action: "ignored", ignored: true };
  }

  const lower = trimmed.toLowerCase();

  // Direct commands — never need LLM (avoids LLM_KEYS_JSON / slow parse)
  const looseSnooze = lower.match(
    /^snooze\s+(\d+)\s*(m|min|mins|minutes|h|hr|hour|hours)?/i,
  );
  if (looseSnooze) {
    let minutes = Number(looseSnooze[1]);
    const unit = looseSnooze[2] || "m";
    if (unit.startsWith("h")) minutes *= 60;
    const idMatch = lower.match(/\bid:([a-z0-9]+)/i);
    const reminder = await findRecentReminder(idMatch?.[1] ?? null);
    if (!reminder) {
      await sendWhatsAppText("No recent reminder to snooze.", chatId);
      return { action: "snooze-miss" };
    }
    const result = await snoozeReminder(reminder.id, minutes);
    await sendWhatsAppText(
      `Snoozed "${reminder.title}" for ${minutes} min.\nNext: ${formatDue(result.dueAt)}`,
      chatId,
    );
    return { action: "snooze", id: reminder.id, dueAt: result.dueAt };
  }

  if (/^(cancel|stop)(\s+it)?(\s+id:([a-z0-9]+))?$/.test(lower) || /^cancel\s+id:([a-z0-9]+)$/.test(lower)) {
    const idMatch = lower.match(/\bid:([a-z0-9]+)/i);
    const reminder = await findRecentReminder(idMatch?.[1] ?? null);
    if (!reminder) {
      await sendWhatsAppText("No recent reminder to cancel.", chatId);
      return { action: "cancel-miss" };
    }
    await prisma.reminder.update({
      where: { id: reminder.id },
      data: { status: "cancelled", lastError: null },
    });
    await sendWhatsAppText(`Cancelled "${reminder.title}".`, chatId);
    return { action: "cancel", id: reminder.id };
  }

  if (/^list\b/.test(lower)) {
    const upcoming = await prisma.reminder.findMany({
      where: { status: "pending" },
      orderBy: { dueAt: "asc" },
      take: 5,
    });
    const lines =
      upcoming.length === 0
        ? "No upcoming reminders."
        : upcoming
            .map(
              (r, i) =>
                `${i + 1}. ${r.title} — ${formatDue(r.dueAt)} (id:${r.id.slice(-6)})`,
            )
            .join("\n");
    await sendWhatsAppText(lines, chatId);
    return { action: "list" };
  }

  // Bare time after a voice note: "11:38PM" → update latest pending voice reminder
  if (looksLikeTimeOnly(lower)) {
    const recentVoice = await prisma.reminder.findFirst({
      where: {
        status: "pending",
        voicePath: { not: null },
        createdAt: { gte: new Date(Date.now() - 5 * 60_000) },
      },
      orderBy: { createdAt: "desc" },
    });
    if (recentVoice) {
      const parsed = parseReminderLocally(trimmed, getUserTimezone());
      const updated = await prisma.reminder.update({
        where: { id: recentVoice.id },
        data: { dueAt: new Date(parsed.dueAt) },
      });
      await sendWhatsAppText(
        `Updated voice reminder "${updated.title}"\nDue: ${formatDue(updated.dueAt)}\nid:${updated.id.slice(-6)}`,
        chatId,
      );
      return { action: "voice-reschedule", id: updated.id, dueAt: updated.dueAt };
    }
    // No recent voice — treat as create with default title
    const parsed = parseReminderLocally(`remind to do it ${trimmed}`, getUserTimezone());
    if (!(await claimFingerprint(`create:${trimmed}`))) {
      return { action: "create-dup", ignored: true };
    }
    const def = await prisma.chatTarget.findFirst({ where: { isDefault: true } });
    const byChat = await prisma.chatTarget.findFirst({ where: { chatId } });
    const reminder = await prisma.reminder.create({
      data: {
        title: "Reminder",
        dueAt: new Date(parsed.dueAt),
        rawInput: trimmed,
        status: "pending",
        chatTargetId: byChat?.id ?? def?.id ?? null,
      },
    });
    await sendWhatsAppText(
      `Saved: "${reminder.title}"\nDue: ${formatDue(reminder.dueAt)}\nid:${reminder.id.slice(-6)}`,
      chatId,
    );
    return { action: "create", id: reminder.id, dueAt: reminder.dueAt };
  }

  // "remind <phone> to …" — always route to that WhatsApp number (skip LLM for target)
  const phone = extractPhoneTarget(trimmed);
  if (phone) {
    if (!(await claimFingerprint(`create:${trimmed}`))) {
      return { action: "create-dup", ignored: true };
    }
    const timezone = getUserTimezone();
    const parsed = parseReminderLocally(phone.textWithoutPhone, timezone);
    const title = titleFromPhoneTask(phone.textWithoutPhone);
    const { id: chatTargetId, label: targetLabel } = await resolveChatTargetId(
      phone.digits,
      chatId,
    );
    const reminder = await prisma.reminder.create({
      data: {
        title,
        body: parsed.body ?? null,
        dueAt: new Date(parsed.dueAt),
        rawInput: trimmed,
        status: "pending",
        recurrenceType: parsed.recurrenceType ?? "none",
        recurrenceWeekdays: parsed.recurrenceWeekdays ?? [],
        chatTargetId,
      },
    });
    await sendWhatsAppText(
      `Saved: "${reminder.title}"\nDue: ${formatDue(reminder.dueAt)}\nTo: ${targetLabel || phone.digits}\nid:${reminder.id.slice(-6)}`,
      chatId,
    );
    return { action: "create", id: reminder.id, dueAt: reminder.dueAt };
  }

  try {
    const { parsed } = await parseReminderWithLlm(trimmed);

    if (parsed.intent === "snooze" && parsed.snoozeMinutes) {
      const reminder = await prisma.reminder.findFirst({
        where: { status: { in: ["sent", "failed", "pending"] } },
        orderBy: [{ sentAt: "desc" }, { createdAt: "desc" }],
      });
      if (!reminder) {
        await sendWhatsAppText("No reminder found to snooze.", chatId);
        return { action: "snooze-miss" };
      }
      const result = await snoozeReminder(reminder.id, parsed.snoozeMinutes);
      await sendWhatsAppText(
        `Snoozed "${reminder.title}" +${parsed.snoozeMinutes}m\nNext: ${formatDue(result.dueAt)}`,
        chatId,
      );
      return { action: "snooze", id: reminder.id, dueAt: result.dueAt };
    }

    if (parsed.intent === "list") {
      const upcoming = await prisma.reminder.findMany({
        where: { status: "pending" },
        orderBy: { dueAt: "asc" },
        take: 5,
      });
      const lines =
        upcoming.length === 0
          ? "No upcoming reminders."
          : upcoming
              .map(
                (r, i) =>
                  `${i + 1}. ${r.title} — ${formatDue(r.dueAt)} (id:${r.id.slice(-6)})`,
              )
              .join("\n");
      await sendWhatsAppText(lines, chatId);
      return { action: "list" };
    }

    if (!(await claimFingerprint(`create:${trimmed}`))) {
      return { action: "create-dup", ignored: true };
    }

    const { id: chatTargetId, label: targetLabel } = await resolveChatTargetId(
      parsed.targetHint,
      chatId,
    );

    const tagNames = parsed.tags ?? [];
    const tagConnect = [];
    for (const name of tagNames) {
      const t = await prisma.tag.upsert({
        where: { name: name.toLowerCase() },
        create: { name: name.toLowerCase(), color: "#0f766e" },
        update: {},
      });
      tagConnect.push({ id: t.id });
    }

    const reminder = await prisma.reminder.create({
      data: {
        title: parsed.title,
        body: parsed.body ?? null,
        dueAt: new Date(parsed.dueAt),
        rawInput: trimmed,
        status: "pending",
        recurrenceType: parsed.recurrenceType ?? "none",
        recurrenceWeekdays: parsed.recurrenceWeekdays ?? [],
        chatTargetId,
        tags: tagConnect.length ? { connect: tagConnect } : undefined,
      },
    });

    const toLine =
      targetLabel && chatTargetId ? `\nTo: ${targetLabel}` : "";
    await sendWhatsAppText(
      `Saved: "${reminder.title}"\nDue: ${formatDue(reminder.dueAt)}${toLine}\nid:${reminder.id.slice(-6)}`,
      chatId,
    );

    return { action: "create", id: reminder.id, dueAt: reminder.dueAt };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await sendWhatsAppText(
      `Could not parse reminder: ${message.slice(0, 200)}`,
      chatId,
    ).catch(() => undefined);
    throw error;
  }
}
