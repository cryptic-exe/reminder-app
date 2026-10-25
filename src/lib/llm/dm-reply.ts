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

export type DmHistoryTurn = {
  fromMe: boolean;
  text: string;
};

const PER_CALL_TIMEOUT_MS = 12_000;
const MAX_PROVIDERS = 2;

/** Rough detect: Devanagari or common Hinglish tokens → Hindi/Hinglish mode. */
function prefersHinglish(text: string): boolean {
  if (/[\u0900-\u097F]/.test(text)) return true;
  const t = text.toLowerCase();
  return /\b(hai|hain|ho|bhai|bhaiya|ji|kya|kese|kaise|kahan|kab|nahi|nahin|mat|thik|theek|acha|accha|haan|han|hua|hu|hun|aap|mai|main|toh|bt(a|ao)|batao|sunao|okji|ok ji|ram ram|namaste|maal|gaadi|factory|uth(a|aya|ao)|bhej|karo|karna|sab|bas)\b/.test(
    t,
  );
}

function fallbackReply(text: string): string {
  return prefersHinglish(text) ? FALLBACK_HI : FALLBACK_EN;
}

function systemPrompt(): string {
  return `You chat on WhatsApp as Deepak Mor's AI assistant (India, transport/logistics).
Sound like a real person texting — short, warm, natural. Not a call-centre bot.

Return ONLY JSON:
{
  "reply": "one WhatsApp message",
  "needsHuman": true/false,
  "confidence": 0-1
}

Language (must follow):
- Match the OTHER PERSON's latest messages. If they use Hinglish/Hindi, reply ONLY in that same Hinglish/Hindi. Never switch to English mid-chat.
- Pure English from them → simple English from you.

Conversation (must follow):
- You get recent chat history. CONTINUE the thread — do not restart with a fresh greeting every time.
- If they already said they are fine / asked how you are, answer briefly and move on. Do NOT ask "kaise ho?" again.
- Never use robotic lines like: "How can I help you today?", "How may I assist you?", "Is there anything else I can help with?"
- Prefer natural closers: "bolo", "batao", "haan boliye", "theek hai", or just answer.
- Greetings only when THEY just greeted (hi / ram ram / namaste). One short greeting, not Namaste + full intro every turn.

Content:
- Small talk and acknowledgements are fine.
- For pickup/load/factory/payment details you don't actually know: needsHuman=true and use the language-matched fallback below.
- Hinglish/Hindi fallback: "${FALLBACK_HI}"
- English fallback: "${FALLBACK_EN}"
- Never invent ETAs, prices, addresses, OTPs, or promises.
- Plain text only. No markdown.`;
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

function buildUserContent(input: {
  text: string;
  fromName: string;
  history?: DmHistoryTurn[];
}): string {
  const corpus = [
    ...(input.history ?? []).map((h) => h.text),
    input.text,
  ].join("\n");
  const hinglish = prefersHinglish(corpus) || prefersHinglish(input.text);
  const langHint = hinglish
    ? "LANGUAGE LOCK: Hinglish/Hindi only. No English sentences."
    : "LANGUAGE: English is fine.";

  const lines: string[] = [
    `From: ${input.fromName}`,
    langHint,
    "Recent chat (oldest → newest):",
  ];
  const hist = (input.history ?? []).slice(-8);
  if (hist.length === 0) {
    lines.push("(no prior turns)");
  } else {
    for (const turn of hist) {
      lines.push(`${turn.fromMe ? "Deepak/AI" : "Them"}: ${turn.text}`);
    }
  }
  lines.push(`Them (latest): ${input.text}`);
  lines.push(
    "Write the next reply only — continue naturally from the history above.",
  );
  return lines.join("\n");
}

/**
 * Draft a WhatsApp reply for a personal DM.
 * Falls back to the "Deepak will get back" line when LLMs fail or are unsure.
 */
export async function generatePersonalDmReply(input: {
  text: string;
  fromName: string;
  history?: DmHistoryTurn[];
}): Promise<DmReplyResult> {
  const keys = loadLlmKeys();
  const chain = buildProviderChain(keys).slice(0, MAX_PROVIDERS);

  const fallback = fallbackReply(
    [input.text, ...(input.history ?? []).map((h) => h.text)].join(" "),
  );

  if (chain.length === 0) {
    return {
      reply: fallback,
      needsHuman: true,
      used: { provider: "local", model: "fallback" },
    };
  }

  const userContent = buildUserContent(input);

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
            temperature: 0.65,
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
          let reply = needsHuman
            ? fallback
            : parsed.reply.trim() || fallback;
          // Strip common robotic English CTA if model slips
          reply = reply
            .replace(/\s*How can I help you today\??/gi, "")
            .replace(/\s*How may I assist you\??/gi, "")
            .trim();
          if (!reply) reply = fallback;
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
