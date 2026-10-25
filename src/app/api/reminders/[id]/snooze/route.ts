import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/auth";
import { jsonError } from "@/lib/api";
import { snoozeReminder } from "@/lib/dispatch";

const BodySchema = z.object({
  minutes: z.number().int().min(1).max(60 * 24 * 7).default(10),
});

type Params = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Params) {
  try {
    await requireAuth();
    const { id } = await params;
    const body = BodySchema.parse(await request.json().catch(() => ({ minutes: 10 })));
    const result = await snoozeReminder(id, body.minutes);
    return NextResponse.json({
      ok: true,
      dueAt: result.dueAt.toISOString(),
    });
  } catch (error) {
    return jsonError(error, 400);
  }
}
