import { NextResponse } from "next/server";
import { z } from "zod";
import { createSession, verifyPassword } from "@/lib/auth";
import { jsonError } from "@/lib/api";

const BodySchema = z.object({
  password: z.string().min(1),
});

export async function POST(request: Request) {
  try {
    const body = BodySchema.parse(await request.json());
    if (!verifyPassword(body.password)) {
      return NextResponse.json({ error: "Invalid password" }, { status: 401 });
    }
    await createSession();
    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonError(error, 400);
  }
}
