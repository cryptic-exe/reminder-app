import { NextResponse } from "next/server";
import { getCronSecret } from "@/lib/env";
import { dispatchDueReminders } from "@/lib/dispatch";
import { pollInboundWhatsApp } from "@/lib/poll-inbound";
import { processDuePersonalDmReplies } from "@/lib/personal-inbox";

export const maxDuration = 60;

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

function isAuthorized(request: Request): boolean {
  try {
    const secret = getCronSecret();
    const header = request.headers.get("authorization");
    if (header === `Bearer ${secret}`) return true;
    const url = new URL(request.url);
    if (url.searchParams.get("secret") === secret) return true;
    return false;
  } catch {
    return false;
  }
}

export async function GET(request: Request) {
  if (!isAuthorized(request)) return unauthorized();

  const [results, inbound, personalDm] = await Promise.all([
    dispatchDueReminders(),
    pollInboundWhatsApp().catch((err) => {
      console.warn(
        "[cron] inbound poll failed:",
        err instanceof Error ? err.message : err,
      );
      return { checked: 0, handled: [] as Array<{ chatId: string; action: string; id?: string }> };
    }),
    processDuePersonalDmReplies().catch((err) => {
      console.warn(
        "[cron] personal DM queue failed:",
        err instanceof Error ? err.message : err,
      );
      return { checked: 0, results: [] };
    }),
  ]);

  return NextResponse.json({
    processed: results.length,
    results,
    inbound,
    personalDm,
  });
}

export async function POST(request: Request) {
  return GET(request);
}
