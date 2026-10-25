import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { jsonError } from "@/lib/api";
import { sendWhatsAppText } from "@/lib/waha";

export async function POST() {
  try {
    await requireAuth();
    const result = await sendWhatsAppText(
      "⏰ Reminder App test — WAHA is connected.",
    );
    return NextResponse.json({ ok: true, messageId: result.messageId });
  } catch (error) {
    return jsonError(error, 502);
  }
}
