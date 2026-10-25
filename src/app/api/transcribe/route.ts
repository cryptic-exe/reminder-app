import { NextResponse } from "next/server";
import OpenAI from "openai";
import { requireAuth } from "@/lib/auth";
import { jsonError } from "@/lib/api";
import { loadLlmKeys } from "@/lib/llm/providers";

/**
 * Whisper transcription via Groq (free tier) or OpenAI-compatible audio endpoint.
 */
export async function POST(request: Request) {
  try {
    await requireAuth();
    const form = await request.formData();
    const file = form.get("audio");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "audio file required" }, { status: 400 });
    }

    const keys = loadLlmKeys();
    const groqKeys = keys.filter((k) => k.platform === "groq").map((k) => k.key);
    const openrouterKeys = keys
      .filter((k) => k.platform === "openrouter")
      .map((k) => k.key);

    const attempts: Array<{ baseURL: string; apiKey: string; model: string }> =
      [];
    for (const apiKey of groqKeys) {
      attempts.push({
        baseURL: "https://api.groq.com/openai/v1",
        apiKey,
        model: "whisper-large-v3-turbo",
      });
    }
    for (const apiKey of openrouterKeys) {
      attempts.push({
        baseURL: "https://openrouter.ai/api/v1",
        apiKey,
        model: "openai/whisper-1",
      });
    }

    if (attempts.length === 0) {
      return NextResponse.json(
        {
          error:
            "No Groq/OpenRouter key for Whisper. Add groq to LLM_KEYS_JSON.",
        },
        { status: 503 },
      );
    }

    let lastError = "transcription failed";
    for (const attempt of attempts) {
      try {
        const client = new OpenAI({
          apiKey: attempt.apiKey,
          baseURL: attempt.baseURL,
        });
        const result = await client.audio.transcriptions.create({
          file,
          model: attempt.model,
          language: "en",
        });
        return NextResponse.json({ text: result.text });
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
    }

    return NextResponse.json({ error: lastError }, { status: 502 });
  } catch (error) {
    return jsonError(error, 400);
  }
}
