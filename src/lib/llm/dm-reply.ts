import OpenAI from "openai";
import { z } from "zod";
import {
  buildProviderChain,
  loadLlmKeys,
  type PlatformId,
} from "./providers";

const FALLBACK_EN = "I'm an AI — Deepak will get back to you.";
const FALLBACK_HI =
  "Main Deepak ka AI assistant hoon — Deepak jaldi dekh ke batayenge.";

/** Casual ack when they raise a real ops issue in Hinglish (still needs Deepak). */
const OPS_ACK_HI =
  "Theek hai bhaiya, samajh gaya — main Deepak ko bata deta hoon, woh check karke aapko batayenge.";
const OPS_ACK_EN =
  "Got it — I'll flag this for Deepak, he'll check and get back to you.";

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
  return /\b(hai|hain|ho|bhai|bhaiya|ji|kya|kese|kaise|kahan|kab|nahi|nahin|mat|thik|theek|acha|accha|haan|han|hua|hu|hun|aap|mai|main|toh|bt(a|ao)|batao|sunao|okji|ok ji|ram ram|namaste|maal|gaadi|factory|uth(a|aya|ao|aya)|bhej|karo|karna|sab|bas|bhadiya|badiya|abhi|tk|tak)\b/.test(
    t,
  );
}

function looksLikeOpsIssue(text: string): boolean {
  const t = text.toLowerCase();
  return /\b(maal|factory|gaadi|pickup|uth(a|aya|ao)|delivery|payment|bill|invoice|load|vehicle|driver|bhej|nahi utha|nhi utha)\b/.test(
    t,
  );
}

/** True if reply is mostly English while we expected Hinglish. */
function isMostlyEnglish(reply: string): boolean {
  if (/[\u0900-\u097F]/.test(reply)) return false;
  const t = reply.toLowerCase();
  const hasHinglish = prefersHinglish(t);
  const hasEnglishSentence =
    /\b(i'll|i will|sure|please|check|status|order|shortly|help you|assist|glad|thank you|how can)\b/.test(
      t,
    );
  return hasEnglishSentence && !hasHinglish;
}

function fallbackReply(text: string, ops: boolean): string {
  const hi = prefersHinglish(text);
  if (ops) return hi ? OPS_ACK_HI : OPS_ACK_EN;
  return hi ? FALLBACK_HI : FALLBACK_EN;
}

function systemPrompt(hinglishLock: boolean, isOpening: boolean): string {
  const langBlock = hinglishLock
    ? `LANGUAGE LOCK (hard rule):
- The other person is chatting in Hinglish/Hindi.
- Your "reply" MUST be Hinglish (Roman Hindi) or Hindi — same vibe as them ("bhaiya", "theek hai", "samajh gaya").
- FORBIDDEN in reply: full English sentences like "Sure, I'll check…", "How can I help you?", "I'll get back to you shortly."
- Example good: "Ram Ram bhai! Main Deepak ka AI assistant hoon — boliye."
- Example good for ops: "Arre theek hai bhaiya, main Deepak ko bata deta hoon — woh check karke batayenge."
- Example BAD: "Sure, I'll check the status of your order…"`
    : `Language: reply in simple English unless they mix Hindi.`;

  const openingBlock = isOpening
    ? hinglishLock
      ? `OPENING (required): Clearly say you are Deepak's AI assistant, not Deepak himself.
Example: "Ram Ram bhai! Main Deepak ka AI assistant hoon — Deepak busy hon toh main madad karta hoon. Boliye?"
Do NOT pretend to be Deepak.`
      : `OPENING (required): Clearly say you are Deepak's AI assistant, not Deepak.
Example: "Hi — I'm Deepak's AI assistant (not Deepak). How can I help?"
Do NOT pretend to be Deepak.`
    : `Identity: You may already have introduced yourself. Don't repeat a long intro every turn; stay clearly the assistant if asked.`;

  return `You chat on WhatsApp as Deepak Mor's AI assistant (India, transport/logistics).
You are NOT Deepak — you assist for him. Sound warm and human, short WhatsApp style.

Return ONLY JSON:
{
  "reply": "one WhatsApp message",
  "needsHuman": true/false,
  "confidence": 0-1
}

${openingBlock}

${langBlock}

Conversation:
- Use recent history. CONTINUE the thread — do not restart with Namaste/Hi every message.
- Don't re-ask "kaise ho?" after they already answered.
- Never use: "How can I help you today?", "How may I assist you?", "Is there anything else…"
- Natural closers: "bolo", "batao", "theek hai", or just answer.

Ops / unknown facts:
- Pickup, factory maal, gaadi, payment, ETAs you don't know → needsHuman=true.
- Still reply in THEIR language with a short human ack that Deepak will check — do NOT invent status.
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
  hinglishLock: boolean;
  isOpening: boolean;
}): string {
  const lines: string[] = [
    `From: ${input.fromName}`,
    input.isOpening
      ? "OPENING TURN: introduce as Deepak's AI (not Deepak)."
      : "Continuing thread — no need to re-introduce unless asked.",
    input.hinglishLock
      ? "HARD LOCK: reply in Hinglish only. Zero English sentences."
      : "Reply in English unless they mixed Hindi.",
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
  lines.push("Next reply only — continue the chat naturally.");
  return lines.join("\n");
}

function ensureAiDisclosure(reply: string, hinglish: boolean): string {
  const lower = reply.toLowerCase();
  if (
    lower.includes("ai assistant") ||
    lower.includes("ai hoon") ||
    lower.includes("ka ai") ||
    /deepak ka ai/i.test(reply)
  ) {
    return reply;
  }
  const prefix = hinglish
    ? "Main Deepak ka AI assistant hoon (Deepak nahi). "
    : "I'm Deepak's AI assistant (not Deepak). ";
  return `${prefix}${reply}`.trim();
}

function scrubRobotic(reply: string): string {
  return reply
    .replace(/\s*How can I help you(?: today)?\??/gi, "")
    .replace(/\s*How may I assist you\??/gi, "")
    .replace(/\s*Is there anything else I can help(?: you)? with\??/gi, "")
    .trim();
}

/**
 * Draft a WhatsApp reply for a personal DM.
 * Falls back to the "Deepak will get back" line when LLMs fail or are unsure.
 */
export async function generatePersonalDmReply(input: {
  text: string;
  fromName: string;
  history?: DmHistoryTurn[];
  isOpening?: boolean;
}): Promise<DmReplyResult> {
  const keys = loadLlmKeys();
  const chain = buildProviderChain(keys).slice(0, MAX_PROVIDERS);
  const isOpening = input.isOpening === true;

  const corpus = [
    input.text,
    ...(input.history ?? []).map((h) => h.text),
  ].join("\n");
  const hinglishLock =
    prefersHinglish(input.text) || prefersHinglish(corpus);
  const ops = looksLikeOpsIssue(input.text);
  const fallback = fallbackReply(corpus, ops);

  if (chain.length === 0) {
    return {
      reply: isOpening
        ? ensureAiDisclosure(fallback, hinglishLock)
        : fallback,
      needsHuman: true,
      used: { provider: "local", model: "fallback" },
    };
  }

  const userContent = buildUserContent({
    ...input,
    hinglishLock,
    isOpening,
  });

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
              {
                role: "system",
                content: systemPrompt(hinglishLock, isOpening),
              },
              { role: "user", content: userContent },
            ],
          });
          const content = completion.choices[0]?.message?.content;
          if (!content) throw new Error("Empty completion");
          const parsed = DmReplySchema.parse(extractJson(content));
          const confidence = parsed.confidence ?? (parsed.needsHuman ? 0.3 : 0.7);
          let needsHuman = parsed.needsHuman || confidence < 0.45 || ops;
          let reply = needsHuman
            ? fallback
            : scrubRobotic(parsed.reply.trim()) || fallback;

          if (hinglishLock && isMostlyEnglish(reply)) {
            reply = fallback;
            needsHuman = true;
          }
          if (isOpening) {
            reply = ensureAiDisclosure(reply, hinglishLock);
          }

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
    reply: isOpening
      ? ensureAiDisclosure(fallback, hinglishLock)
      : fallback,
    needsHuman: true,
    used: { provider: "local", model: "fallback" },
  };
}

export { FALLBACK_EN as FALLBACK_REPLY, FALLBACK_HI, OPS_ACK_HI };
