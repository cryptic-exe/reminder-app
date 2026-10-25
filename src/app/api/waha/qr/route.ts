import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { jsonError } from "@/lib/api";
import { getWahaQr } from "@/lib/waha";

export async function GET() {
  try {
    await requireAuth();
    const qr = await getWahaQr();
    return NextResponse.json(qr);
  } catch (error) {
    return jsonError(error, 502);
  }
}
