import { prisma } from "@/lib/db";
import { claimFingerprint, claimMessageId } from "@/lib/inbound-dedupe";
import { parseReminderLocally } from "@/lib/llm/local-parse";
import { getUserTimezone } from "@/lib/env";
import { formatInUserTz } from "@/lib/time";
import { transcribeAudio } from "@/lib/transcribe";
import { downloadWahaMedia, sendWhatsAppText } from "@/lib/waha";
import { saveVoiceFile } from "@/lib/voice-store";

function formatDue(dueAt: Date): string {
  return formatInUserTz(dueAt.toISOString(), getUserTimezone());
}

function isAudioMime(mime: string | undefined | null): boolean {
  if (!mime) return false;
  const m = mime.toLowerCase();
  return (
    m.startsWith("audio/") ||
    m.includes("ogg") ||
    m.includes("opus") ||
    m.includes("ptt")
  );
}

export type InboundMedia = {
  url?: string | null;
  mimetype?: string | null;
  filename?: string | null;
};

/**
 * Create a reminder from a WhatsApp voice note:
 * download → store → transcribe → parse due time → save.
 * At due time the same audio is re-sent via sendVoice.
 */
export async function processInboundVoice(input: {
  messageId: string;
  chatId: string;
  caption?: string | null;
  media: InboundMedia;
}): Promise<{ action: string; id?: string; ignored?: boolean }> {
  if (!isAudioMime(input.media.mimetype)) {
    return { action: "ignored", ignored: true };
  }
  if (!input.media.url) {
    await sendWhatsAppText(
      "Got a voice note but WAHA didn’t attach a media URL. Enable media download on the WAHA server (WHATSAPP_DOWNLOAD_MEDIA=true), then try again.",
      input.chatId,
    ).catch(() => undefined);
    return { action: "voice-no-url" };
  }

  if (!(await claimMessageId(input.messageId))) {
    return { action: "create-dup", ignored: true };
  }
  if (!(await claimFingerprint(`voice:${input.messageId}`))) {
    return { action: "create-dup", ignored: true };
  }

  const { bytes, mime } = await downloadWahaMedia(input.media.url);
  const stored = await saveVoiceFile(bytes, mime || input.media.mimetype || "audio/ogg");

  let transcript = "";
  try {
    transcript = await transcribeAudio(
      bytes,
      input.media.filename || "voice.ogg",
      mime || input.media.mimetype || "audio/ogg",
    );
  } catch (err) {
    console.warn(
      "[inbound-voice] transcribe failed:",
      err instanceof Error ? err.message : err,
    );
  }

  const caption = (input.caption || "").trim();
  const parseText =
    caption ||
    transcript ||
    "voice reminder";
  const timezone = getUserTimezone();
  const parsed = parseReminderLocally(parseText, timezone);

  const title =
    (parsed.confidence >= 0.7 && parsed.title) ||
    (transcript && transcript.slice(0, 80)) ||
    (caption && caption.slice(0, 80)) ||
    "Voice reminder";

  const def = await prisma.chatTarget.findFirst({
    where: { isDefault: true },
  });
  const byChat = await prisma.chatTarget.findFirst({
    where: { chatId: input.chatId },
  });

  const reminder = await prisma.reminder.create({
    data: {
      title,
      body: transcript && transcript !== title ? transcript : null,
      dueAt: new Date(parsed.dueAt),
      rawInput: caption
        ? `voice: ${caption}`
        : `voice: ${transcript || "(no transcript)"}`,
      status: "pending",
      voicePath: stored.relativePath,
      voiceMime: mime || input.media.mimetype || "audio/ogg",
      chatTargetId: byChat?.id ?? def?.id ?? null,
      recurrenceType: parsed.recurrenceType ?? "none",
      recurrenceWeekdays: parsed.recurrenceWeekdays ?? [],
    },
  });

  await sendWhatsAppText(
    `Saved voice reminder: "${reminder.title}"\nDue: ${formatDue(reminder.dueAt)}\n(Will re-send the voice note)\nid:${reminder.id.slice(-6)}`,
    input.chatId,
  );

  return { action: "create-voice", id: reminder.id };
}
