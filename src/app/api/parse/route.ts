import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/auth";
import { jsonError } from "@/lib/api";
import { parseReminderWithLlm } from "@/lib/llm/router";

const BodySchema = z.object({
  text: z.string().trim().min(1).max(2000),
});

export async function POST(request: Request) {
  try {
    await requireAuth();
    const { text } = BodySchema.parse(await request.json());
    const result = await parseReminderWithLlm(text);
    return NextResponse.json({
      intent: result.parsed.intent ?? "create",
      title: result.parsed.title,
      body: result.parsed.body ?? null,
      dueAt: result.parsed.dueAt,
      confidence: result.parsed.confidence ?? null,
      recurrenceType: result.parsed.recurrenceType ?? "none",
      recurrenceWeekdays: result.parsed.recurrenceWeekdays ?? [],
      tags: result.parsed.tags ?? [],
      snoozeMinutes: result.parsed.snoozeMinutes ?? null,
      targetHint: result.parsed.targetHint ?? null,
      rawInput: text,
      provider: result.used.provider,
      model: result.used.model,
    });
  } catch (error) {
    return jsonError(error, 400);
  }
}
