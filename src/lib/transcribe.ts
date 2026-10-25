import OpenAI from "openai";
import { loadLlmKeys } from "@/lib/llm/providers";
import { toFile } from "openai/uploads";

/** Transcribe audio bytes via Groq Whisper (or OpenRouter fallback). */
export async function transcribeAudio(
  bytes: Buffer,
  filename = "voice.ogg",
  mime = "audio/ogg",
): Promise<string> {
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
    throw new Error("No Groq/OpenRouter key for Whisper transcription");
  }

  let lastError = "transcription failed";
  for (const attempt of attempts) {
    try {
      const client = new OpenAI({
        apiKey: attempt.apiKey,
        baseURL: attempt.baseURL,
      });
      const file = await toFile(bytes, filename, { type: mime });
      const result = await client.audio.transcriptions.create({
        file,
        model: attempt.model,
      });
      const text = result.text?.trim();
      if (text) return text;
      lastError = "empty transcription";
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  throw new Error(lastError);
}
