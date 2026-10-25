import OpenAI from "openai";
import { z } from "zod";
import {
  buildProviderChain,
  loadLlmKeys,
  type PlatformId,
} from "./providers";

const FALLBACK_REPLY =
  "I'm an AI — Deepak will get back to you.";

const DmReplySchema = z.object({
  reply: z.string().min(1).max(800),
  needsHuman: z.boolean(),
  confidence: z.number().min(0).max(1).optional(),
});

export type DmReplyResult = {
  reply: string;
  needsHuman: boolean;
  used: { provider: PlatformId; model: string };
};

const PER_CALL_TIMEOUT_MS = 12_000;
const MAX_PROVIDERS = 2;

function systemPrompt(): string {
  return `You answer WhatsApp DMs on behalf of Deepak Mor (India).
You are an AI assistant for Deepak — be warm, brief, and professional (WhatsApp style, under ~400 characters).

Return ONLY JSON:
{
  "reply": "message to send to the person",
  "needsHuman": true/false,
  "confidence": 0-1
}

Rules:
- Answer greetings, thanks, simple logistics you can reasonably handle, and acknowledge requests.
- If the question needs Deepak's personal knowledge, private business details, money decisions, commitments, OTPs, or anything you are unsure about: set needsHuman=true and set reply exactly to: "${FALLBACK_REPLY}"
- Never invent prices, schedules, addresses, account numbers, or promises Deepak did not authorize.
- Do not mention being a reminder bot unless asked.
- No markdown. Plain text only in reply.`;
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

/**
 * Draft a WhatsApp reply for a personal DM.
 * Falls back to the "Deepak will get back" line when LLMs fail or are unsure.
 */
export async function generatePersonalDmReply(input: {
  text: string;
  fromName: string;
}): Promise<DmReplyResult> {
  const keys = loadLlmKeys();
  const chain = buildProviderChain(keys).slice(0, MAX_PROVIDERS);

  if (chain.length === 0) {
    return {
      reply: FALLBACK_REPLY,
      needsHuman: true,
      used: { provider: "local", model: "fallback" },
    };
  }

  const userContent = `From: ${input.fromName}\nMessage: ${input.text}`;

  for (const { endpoint, apiKeys } of chain) {
    for (const apiKey of apiKeys.slice(0, 1)) {
      const client = new OpenAI({
        apiKey,
        baseURL: endpoint.baseURL,
        defaultHeaders: endpoint.extraHeaders,
        timeout: PER_CALL_TIMEOUT_MS,
      });
      for (const model of endpoint.models.slice(0, 3)) {
        try {
          const completion = await client.chat.completions.create({
            model,
            temperature: 0.3,
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: systemPrompt() },
              { role: "user", content: userContent },
            ],
          });
          const content = completion.choices[0]?.message?.content;
          if (!content) throw new Error("Empty completion");
          const parsed = DmReplySchema.parse(extractJson(content));
          const confidence = parsed.confidence ?? (parsed.needsHuman ? 0.3 : 0.7);
          const needsHuman = parsed.needsHuman || confidence < 0.45;
          const reply = needsHuman
            ? FALLBACK_REPLY
            : parsed.reply.trim() || FALLBACK_REPLY;
          return {
            reply,
            needsHuman: needsHuman || reply === FALLBACK_REPLY,
            used: { provider: endpoint.id, model },
          };
        } catch (err) {
          console.warn(
            "[dm-reply]",
            endpoint.id,
            model,
            err instanceof Error ? err.message : err,
          );
        }
      }
    }
  }

  return {
    reply: FALLBACK_REPLY,
    needsHuman: true,
    used: { provider: "local", model: "fallback" },
  };
}

export { FALLBACK_REPLY };
