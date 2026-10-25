import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/auth";
import { jsonError } from "@/lib/api";
import { getWahaServerConfig } from "@/lib/env";
import {
  ensureWahaSession,
  getWahaSession,
  logoutWahaSession,
  restartWahaSession,
  startWahaSession,
  stopWahaSession,
} from "@/lib/waha";

const ActionSchema = z.object({
  action: z.enum(["start", "stop", "restart", "logout", "ensure"]),
});

export async function GET() {
  try {
    await requireAuth();
    const server = getWahaServerConfig();
    const session = await getWahaSession();
    return NextResponse.json({
      configured: true,
      baseUrl: server.baseUrl,
      sessionName: server.session,
      chatIdEnv: process.env.WHATSAPP_CHAT_ID || null,
      session,
    });
  } catch (error) {
    return jsonError(error, 502);
  }
}

export async function POST(request: Request) {
  try {
    await requireAuth();
    const { action } = ActionSchema.parse(await request.json());

    let session = null;
    switch (action) {
      case "ensure":
        session = await ensureWahaSession();
        break;
      case "start":
        session = await startWahaSession();
        break;
      case "stop":
        session = await stopWahaSession();
        break;
      case "restart":
        session = await restartWahaSession();
        break;
      case "logout":
        session = await logoutWahaSession();
        break;
    }

    return NextResponse.json({ session });
  } catch (error) {
    return jsonError(error, 400);
  }
}
