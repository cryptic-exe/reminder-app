import OpenAI from "openai";
import { z } from "zod";
import {
  buildProviderChain,
  loadLlmKeys,
  type PlatformId,
} from "./providers";

const FALLBACK_EN = "I'm an AI — Deepak will get back to you.";
const FALLBACK_HI =
  "Main Deepak ka AI assistant hoon — Deepak jaldi reply karenge.";

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

/** Rough detect: Devanagari or common Hinglish tokens → Hindi/Hinglish mode. */
function prefersHinglish(text: string): boolean {
  if (/[\u0900-\u097F]/.test(text)) return true;
  const t = text.toLowerCase();
  return /\b(hai|hain|ho|bhai|bhaiya|ji|kya|kese|kaise|kahan|kab|nahi|nahin|mat|thik|theek|acha|accha|haan|han|okji|ok ji|ram ram|namaste|maal|gaadi|factory|uth(a|aya|ao)|bhej|karo|karna|batao|sunao)\b/.test(
    t,
  );
}

function fallbackReply(text: string): string {
  return prefersHinglish(text) ? FALLBACK_HI : FALLBACK_EN;
}

function systemPrompt(): string {
  return `You answer WhatsApp DMs on behalf of Deepak Mor (India logistics / transport).
You are Deepak's AI assistant — sound like a real person on WhatsApp, not a corporate bot.

Return ONLY JSON:
{
  "reply": "message to send to the person",
  "needsHuman": true/false,
  "confidence": 0-1
}

Language (critical):
- Mirror the sender's language exactly.
- Hindi (Devanagari) → reply in natural Hindi.
- Hinglish (Roman Hindi mixed with English, e.g. "kese ho bhaiya", "maal nahi utha") → reply in the same Hinglish, casual and warm.
- English → reply in simple English.
- Do NOT switch to English if they wrote in Hindi/Hinglish.

Tone:
- Short WhatsApp style (under ~400 characters). Human, friendly, North-India casual when they are casual ("bhaiya", "ji" ok if they used it).
- No markdown, no bullet lists, no "As an AI…" fluff.
- Greetings: match their greeting (Ram Ram / Namaste / Hi) then help.

Content rules:
- Answer greetings, thanks, simple acknowledgements, and light logistics follow-ups you can safely handle.
- If it needs Deepak's private knowledge, money, commitments, OTPs, exact schedules/prices you don't know, or anything unsure: needsHuman=true and set reply to the matching fallback:
  - Hinglish/Hindi: "${FALLBACK_HI}"
  - English: "${FALLBACK_EN}"
- Never invent prices, ETAs, addresses, account numbers, or promises.`;
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

  const fallback = fallbackReply(input.text);

  if (chain.length === 0) {
    return {
      reply: fallback,
      needsHuman: true,
      used: { provider: "local", model: "fallback" },
    };
  }

  const langHint = prefersHinglish(input.text)
    ? "Reply in Hinglish/Hindi only — same style as their message."
    : "Reply in English unless they mixed Hindi.";
  const userContent = `From: ${input.fromName}\n${langHint}\nMessage: ${input.text}`;

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
            temperature: 0.55,
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
            ? fallback
            : parsed.reply.trim() || fallback;
          return {
            reply,
            needsHuman: needsHuman || reply === fallback,
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
    reply: fallback,
    needsHuman: true,
    used: { provider: "local", model: "fallback" },
  };
}

export { FALLBACK_EN as FALLBACK_REPLY, FALLBACK_HI };
