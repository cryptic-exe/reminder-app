import OpenAI from "openai";
import { z } from "zod";
import { getUserTimezone } from "@/lib/env";
import { parseReminderLocally } from "./local-parse";
import {
  buildProviderChain,
  listUnsupportedPlatforms,
  loadLlmKeys,
  type PlatformId,
} from "./providers";

export const ParsedReminderSchema = z.object({
  title: z.string().min(1),
  dueAt: z.string().min(1),
  body: z.string().nullable().optional(),
  confidence: z.number().min(0).max(1).optional(),
  recurrenceType: z.enum(["none", "daily", "weekly"]).optional(),
  recurrenceWeekdays: z.array(z.number().int().min(0).max(6)).optional(),
  tags: z.array(z.string()).optional(),
  snoozeMinutes: z.number().optional(),
  intent: z.enum(["create", "snooze", "list", "cancel", "unknown"]).optional(),
  targetHint: z.string().nullable().optional(),
});

export type ParsedReminder = z.infer<typeof ParsedReminderSchema>;

const PER_CALL_TIMEOUT_MS = 8_000;
const MAX_PROVIDERS = 2;
const MAX_MODELS_PER_PROVIDER = 1;

function buildSystemPrompt(timezone: string, nowIso: string): string {
  return `You extract reminder / command details from natural language.
Current datetime (ISO UTC): ${nowIso}
User timezone: ${timezone}

Return ONLY a JSON object with:
- intent: "create" | "snooze" | "list" | "cancel" | "unknown"
- title: short reminder title (string)
- dueAt: absolute datetime as ISO-8601 with offset or Z (string)
- body: optional extra detail, or null
- confidence: 0-1
- recurrenceType: "none" | "daily" | "weekly" (default none)
- recurrenceWeekdays: array of 0=Sun..6=Sat for weekly (e.g. every Monday → [1])
- tags: optional short labels like ["work","health"]
- snoozeMinutes: if intent is snooze, minutes to delay (e.g. 10, 60)
- targetHint: optional chat target name, OR a phone number digits string (e.g. "9198XXXXXXXX"), or null

Rules:
- "every day at 9", "daily" → recurrenceType daily
- "every Monday 9am", "weekly on Mon and Thu" → weekly + weekdays
- "snooze 10", "remind me again in 10 minutes" → intent snooze + snoozeMinutes
- "remind 9198XXXXXXXX to send images at 5pm" → title about the task (e.g. "Send images"), targetHint = "9198XXXXXXXX" (digits only, with country code)
- Interpret relative times in the user timezone, then output ISO-8601.
- If no time but a day, default to 09:00 local.
- If missing due time for create, dueAt = 1 hour from now, confidence <= 0.4.
- title is the task itself, not the time phrase or phone number.
- Do not wrap JSON in markdown.`;
}

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("Model did not return JSON");
    return JSON.parse(match[0]);
  }
}

type AttemptError = {
  provider: PlatformId;
  model: string;
  status?: number;
  message: string;
};

export async function parseReminderWithLlm(
  userText: string,
): Promise<{
  parsed: ParsedReminder;
  used: { provider: PlatformId; model: string };
}> {
  const timezone = getUserTimezone();
  const nowIso = new Date().toISOString();
  const errors: AttemptError[] = [];

  // Fast path: skip slow free-tier LLMs when a local parse is confident
  const local = parseReminderLocally(userText, timezone);
  if ((local.confidence ?? 0) >= 0.7) {
    return {
      parsed: local,
      used: { provider: "local", model: "rules" },
    };
  }

  const keys = loadLlmKeys();
  const chain = buildProviderChain(keys).slice(0, MAX_PROVIDERS);

  if (chain.length === 0) {
    const unsupported = listUnsupportedPlatforms(keys);
    if (keys.length > 0 && unsupported.length > 0) {
      console.warn(
        "[llm] no supported platforms; using local parser. unsupported:",
        unsupported.slice(0, 8).join(", "),
      );
    }
    return {
      parsed: local,
      used: { provider: "local", model: "rules" },
    };
  }

  for (const { endpoint, apiKeys } of chain) {
    for (const apiKey of apiKeys.slice(0, 1)) {
      const client = new OpenAI({
        apiKey,
        baseURL: endpoint.baseURL,
        defaultHeaders: endpoint.extraHeaders,
        timeout: PER_CALL_TIMEOUT_MS,
      });

      for (const model of endpoint.models.slice(0, MAX_MODELS_PER_PROVIDER)) {
        try {
          const completion = await client.chat.completions.create({
            model,
            temperature: 0.1,
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: buildSystemPrompt(timezone, nowIso) },
              { role: "user", content: userText },
            ],
          });

          const content = completion.choices[0]?.message?.content;
          if (!content) throw new Error("Empty completion");

          const parsed = ParsedReminderSchema.parse(extractJson(content));
          const due = new Date(parsed.dueAt);
          if (Number.isNaN(due.getTime()) && parsed.intent !== "snooze") {
            throw new Error(`Invalid dueAt: ${parsed.dueAt}`);
          }

          return {
            parsed: {
              ...parsed,
              dueAt: Number.isNaN(due.getTime())
                ? new Date(Date.now() + 3600_000).toISOString()
                : due.toISOString(),
              body: parsed.body ?? null,
              recurrenceType: parsed.recurrenceType ?? "none",
              recurrenceWeekdays: parsed.recurrenceWeekdays ?? [],
              tags: parsed.tags ?? [],
              intent: parsed.intent ?? "create",
            },
            used: { provider: endpoint.id, model },
          };
        } catch (err) {
          const status =
            err && typeof err === "object" && "status" in err
              ? Number((err as { status: number }).status)
              : undefined;
          const message = err instanceof Error ? err.message : String(err);
          errors.push({
            provider: endpoint.id,
            model,
            status,
            message,
          });
          if (status === 401 || status === 403) break;
        }
      }
    }
  }

  console.warn(
    "[llm] all providers failed; using local parser.",
    errors
      .slice(-5)
      .map((e) => `${e.provider}/${e.model}: ${e.message}`)
      .join("; "),
  );

  return {
    parsed: local,
    used: { provider: "local", model: "rules" },
  };
}
