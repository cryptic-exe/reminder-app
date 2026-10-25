import { NextResponse } from "next/server";
import { AuthError } from "@/lib/auth";

export function jsonError(error: unknown, fallbackStatus = 500) {
  if (error instanceof AuthError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  const message = error instanceof Error ? error.message : "Unexpected error";
  const status =
    message.includes("not set") || message.includes("not configured")
      ? 503
      : fallbackStatus;
  return NextResponse.json({ error: message }, { status });
}
