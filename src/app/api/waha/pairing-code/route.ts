import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/auth";
import { jsonError } from "@/lib/api";
import { requestWahaPairingCode } from "@/lib/waha";

const BodySchema = z.object({
  phoneNumber: z.string().min(8).max(20),
});

export async function POST(request: Request) {
  try {
    await requireAuth();
    const { phoneNumber } = BodySchema.parse(await request.json());
    const result = await requestWahaPairingCode(phoneNumber);
    return NextResponse.json(result);
  } catch (error) {
    return jsonError(error, 400);
  }
}
