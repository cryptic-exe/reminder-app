import { prisma } from "@/lib/db";
import { nextDueAfter } from "@/lib/recurrence";
import { sendReminderWhatsApp } from "@/lib/waha";

export type DispatchResult = {
  id: string;
  ok: boolean;
  error?: string;
  messageId?: string;
  nextDueAt?: string;
};

/** Claim and send due pending reminders via WAHA. Safe to call from cron or UI. */
export async function dispatchDueReminders(
  limit = 20,
): Promise<DispatchResult[]> {
  const results: DispatchResult[] = [];

  const due = await prisma.reminder.findMany({
    where: {
      status: "pending",
      dueAt: { lte: new Date() },
    },
    include: { chatTarget: true, tags: true },
    orderBy: { dueAt: "asc" },
    take: limit,
  });

  for (const reminder of due) {
    const claim = await prisma.reminder.updateMany({
      where: { id: reminder.id, status: "pending" },
      data: { status: "sending" },
    });
    if (claim.count !== 1) continue;

    try {
      const chatId =
        reminder.chatTarget?.chatId || process.env.WHATSAPP_CHAT_ID || null;
      const envChatId = process.env.WHATSAPP_CHAT_ID || null;
      const compact = Boolean(chatId && envChatId && chatId !== envChatId);

      const sent = await sendReminderWhatsApp({
        title: reminder.title,
        body: reminder.body,
        rawInput: reminder.rawInput,
        dueAt: reminder.dueAt,
        chatId,
        reminderId: reminder.id,
        compact,
        voicePath: reminder.voicePath,
        voiceMime: reminder.voiceMime,
      });

      if (reminder.recurrenceType !== "none") {
        const next = nextDueAfter({
          from: reminder.dueAt,
          recurrenceType: reminder.recurrenceType,
          recurrenceWeekdays: reminder.recurrenceWeekdays,
        });
        if (next) {
          await prisma.reminder.update({
            where: { id: reminder.id },
            data: {
              status: "pending",
              dueAt: next,
              sentAt: new Date(),
              whatsappMessageId: sent.messageId ?? null,
              lastError: null,
            },
          });
          results.push({
            id: reminder.id,
            ok: true,
            messageId: sent.messageId,
            nextDueAt: next.toISOString(),
          });
          continue;
        }
      }

      await prisma.reminder.update({
        where: { id: reminder.id },
        data: {
          status: "sent",
          sentAt: new Date(),
          whatsappMessageId: sent.messageId ?? null,
          lastError: null,
        },
      });

      results.push({ id: reminder.id, ok: true, messageId: sent.messageId });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await prisma.reminder.update({
        where: { id: reminder.id },
        data: {
          status: "failed",
          lastError: message.slice(0, 1000),
        },
      });
      results.push({ id: reminder.id, ok: false, error: message });
    }
  }

  return results;
}

export async function snoozeReminder(
  id: string,
  minutes: number,
): Promise<{ id: string; dueAt: Date }> {
  const dueAt = new Date(Date.now() + minutes * 60_000);
  const updated = await prisma.reminder.update({
    where: { id },
    data: {
      dueAt,
      status: "pending",
      lastError: null,
      sentAt: null,
    },
  });
  return { id: updated.id, dueAt: updated.dueAt };
}

/** Resolve a short suffix (last 6 of cuid) to a reminder id. */
export async function findReminderByShortId(shortId: string) {
  const all = await prisma.reminder.findMany({
    where: {
      OR: [{ status: "sent" }, { status: "pending" }, { status: "failed" }],
    },
    orderBy: { createdAt: "desc" },
    take: 80,
  });

  const needle = shortId.toLowerCase();
  return all.find((r) => r.id.toLowerCase().endsWith(needle)) ?? null;
}
