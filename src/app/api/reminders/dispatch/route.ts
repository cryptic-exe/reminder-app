import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { jsonError } from "@/lib/api";
import { dispatchDueReminders } from "@/lib/dispatch";
import { pollInboundWhatsApp } from "@/lib/poll-inbound";

/** Logged-in user can flush due reminders (local dev / open tab). */
export async function POST() {
  try {
    await requireAuth();
    const [results, inbound] = await Promise.all([
      dispatchDueReminders(),
      pollInboundWhatsApp().catch(() => ({
        checked: 0,
        handled: [] as Array<{ chatId: string; action: string; id?: string }>,
      })),
    ]);
    return NextResponse.json({
      processed: results.length,
      results,
      inbound,
    });
  } catch (error) {
    return jsonError(error, 502);
  }
}
