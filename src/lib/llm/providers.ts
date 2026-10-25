import fs from "fs";
import path from "path";

export type PlatformId = string;

export type ProviderEndpoint = {
  id: PlatformId;
  baseURL: string;
  models: string[];
  extraHeaders?: Record<string, string>;
};

/** FreeLLMAPI export / declarative key row */
type FreeLlmKeyRow = {
  platform: string;
  key: string;
  label?: string;
  enabled?: boolean;
};

type FreeLlmExport = {
  version?: number;
  source?: string;
  keys: FreeLlmKeyRow[];
};

export type LoadedKey = {
  platform: PlatformId;
  key: string;
};

/**
 * OpenAI-compatible platforms from FreeLLMAPI's registry.
 * Platforms that need native adapters (Cohere, Cloudflare compound keys, etc.)
 * are omitted until we add dedicated clients.
 */
export const PLATFORM_REGISTRY: Record<string, ProviderEndpoint> = {
  groq: {
    id: "groq",
    baseURL: "https://api.groq.com/openai/v1",
    // Free/dev tier: llama-3.3-70b-versatile / 3.1-8b-instant shut down Aug 2026
    models: ["openai/gpt-oss-20b", "openai/gpt-oss-120b", "llama-3.3-70b-versatile"],
  },
  google: {
    id: "google",
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
    models: ["gemini-2.5-flash", "gemini-2.0-flash-lite", "gemini-2.0-flash"],
  },
  cerebras: {
    id: "cerebras",
    baseURL: "https://api.cerebras.ai/v1",
    models: ["llama3.1-8b", "llama-3.3-70b"],
  },
  mistral: {
    id: "mistral",
    baseURL: "https://api.mistral.ai/v1",
    models: ["mistral-small-latest", "open-mistral-nemo"],
  },
  openrouter: {
    id: "openrouter",
    baseURL: "https://openrouter.ai/api/v1",
    models: [
      "google/gemini-2.0-flash-exp:free",
      "meta-llama/llama-3.3-70b-instruct:free",
    ],
    extraHeaders: {
      "HTTP-Referer": "https://reminder-app.local",
      "X-Title": "Reminder App",
    },
  },
  nvidia: {
    id: "nvidia",
    baseURL: "https://integrate.api.nvidia.com/v1",
    models: ["meta/llama-3.1-8b-instruct", "google/gemma-2-9b-it"],
  },
  huggingface: {
    id: "huggingface",
    baseURL: "https://router.huggingface.co/v1",
    models: ["meta-llama/Llama-3.1-8B-Instruct", "Qwen/Qwen2.5-7B-Instruct"],
  },
  ollama: {
    id: "ollama",
    baseURL: "https://ollama.com/v1",
    models: ["gpt-oss:120b-cloud", "llama3.1:8b"],
  },
  kilo: {
    id: "kilo",
    baseURL: "https://api.kilo.ai/api/gateway/v1",
    models: [
      "google/gemini-2.0-flash-exp:free",
      "meta-llama/llama-3.3-70b-instruct:free",
    ],
  },
  llm7: {
    id: "llm7",
    baseURL: "https://api.llm7.io/v1",
    models: ["gpt-4.1-nano", "llama-3.1-8b-instruct"],
  },
  ovh: {
    id: "ovh",
    baseURL: "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1",
    models: ["Llama-3.1-8B-Instruct", "Mixtral-8x7B-Instruct-v0.1"],
  },
  agnes: {
    id: "agnes",
    baseURL: "https://apihub.agnes-ai.com/v1",
    models: ["agnes-3.0-flash", "agnes-2.5-pro"],
  },
  aion: {
    id: "aion",
    baseURL: "https://api.aionlabs.ai/v1",
    models: [
      "aion-labs/aion-3.0-mini",
      "aion-labs/aion-2.0",
      "aion-labs/aion-rp-llama-3.1-8b",
    ],
  },
  requesty: {
    id: "requesty",
    baseURL: "https://router.requesty.ai/v1",
    models: ["auto"],
  },
  navy: {
    id: "navy",
    baseURL: "https://api.navy/v1",
    models: ["gpt-4.1-nano", "llama-3.3-70b"],
  },
  nara: {
    id: "nara",
    baseURL: "https://router.bynara.id/v1",
    models: ["mistral-large-latest", "mistral-medium-latest"],
  },
  sealion: {
    id: "sealion",
    baseURL: "https://api.sea-lion.ai/v1",
    models: ["aisingapore/Gemma-SEA-LION-v4-27B-IT"],
  },
  orcarouter: {
    id: "orcarouter",
    baseURL: "https://api.orcarouter.ai/v1",
    models: ["auto"],
  },
  unorouter: {
    id: "unorouter",
    baseURL: "https://api.unorouter.com/v1",
    models: ["glm-5.3-flash:free", "glm-5.3:free"],
  },
  xkiro: {
    id: "xkiro",
    baseURL: "https://api.xkiro.com/v1",
    models: ["qwen/qwen3.8-max:free", "deepseek/deepseek-chat:free"],
  },
  bazaarlink: {
    id: "bazaarlink",
    baseURL: "https://bazaarlink.ai/api/v1",
    models: ["auto:free"],
  },
  routeway: {
    id: "routeway",
    baseURL: "https://api.routeway.ai/v1",
    models: ["auto"],
    extraHeaders: {
      "User-Agent":
        "Mozilla/5.0 (compatible; ReminderApp/1.0; +https://localhost)",
    },
  },
  ainative: {
    id: "ainative",
    baseURL: "https://api.ainative.studio/api/v1",
    models: ["Qwen/Qwen2.5-7B-Instruct", "deepseek-ai/DeepSeek-V3"],
  },
  siliconflow: {
    id: "siliconflow",
    baseURL: "https://api.siliconflow.com/v1",
    models: ["Qwen/Qwen2.5-7B-Instruct", "deepseek-ai/DeepSeek-V3"],
  },
  reka: {
    id: "reka",
    baseURL: "https://api.reka.ai/v1",
    models: ["reka-flash", "reka-edge"],
  },
  anyapi: {
    id: "anyapi",
    baseURL: "https://api.anyapi.ai/v1",
    models: ["meta-llama/llama-3.3-70b-instruct:free"],
  },
  bai: {
    id: "bai",
    baseURL: "https://api.b.ai/v1",
    models: ["auto"],
  },
  longcat: {
    id: "longcat",
    baseURL: "https://api.longcat.chat/openai/v1",
    models: ["LongCat-Flash-Chat"],
  },
  zhipu: {
    id: "zhipu",
    baseURL: "https://api.z.ai/api/paas/v4",
    models: ["glm-4.7-flash", "glm-4.5-flash"],
  },
};

/** Preferred failover order when several platforms have keys. */
export const PREFERRED_ORDER: PlatformId[] = [
  "groq",
  "google",
  "cerebras",
  "agnes",
  "aion",
  "mistral",
  "nvidia",
  "openrouter",
  "kilo",
  "xkiro",
  "unorouter",
  "huggingface",
  "llm7",
  "navy",
  "requesty",
  "ovh",
  "ollama",
  "bazaarlink",
  "routeway",
  "ainative",
  "siliconflow",
  "nara",
  "sealion",
  "orcarouter",
  "anyapi",
  "zhipu",
  "longcat",
  "reka",
  "bai",
];

function isFreeLlmExport(value: unknown): value is FreeLlmExport {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as FreeLlmExport).keys)
  );
}

function isSimpleMap(value: unknown): value is Record<string, string[] | string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  if ("keys" in value) return false;
  return Object.values(value).every(
    (v) => typeof v === "string" || (Array.isArray(v) && v.every((x) => typeof x === "string")),
  );
}

/** Parse FreeLLMAPI export JSON or legacy `{ "groq": ["…"] }` map. */
export function parseLlmKeysJson(raw: string): LoadedKey[] {
  const parsed: unknown = JSON.parse(raw);
  const loaded: LoadedKey[] = [];

  if (isFreeLlmExport(parsed)) {
    for (const row of parsed.keys) {
      if (!row?.platform || !row?.key) continue;
      if (row.enabled === false) continue;
      loaded.push({ platform: row.platform.toLowerCase(), key: row.key.trim() });
    }
    return loaded;
  }

  if (isSimpleMap(parsed)) {
    for (const [platform, value] of Object.entries(parsed)) {
      const keys = Array.isArray(value) ? value : [value];
      for (const key of keys) {
        if (typeof key === "string" && key.trim()) {
          loaded.push({ platform: platform.toLowerCase(), key: key.trim() });
        }
      }
    }
    return loaded;
  }

  throw new Error(
    "LLM_KEYS_JSON must be a FreeLLMAPI export ({ keys: [{ platform, key }] }) or a simple map ({ groq: [\"…\"] })",
  );
}

function readKeysRaw(): string | null {
  // Prefer a JSON file — Next.js @next/env strips " from large inline LLM_KEYS_JSON values
  const fileHint =
    process.env.LLM_KEYS_FILE?.trim() ||
    (process.env.LLM_KEYS_JSON?.trim().endsWith(".json")
      ? process.env.LLM_KEYS_JSON.trim()
      : "");
  if (fileHint) {
    try {
      const resolved = path.isAbsolute(fileHint)
        ? fileHint
        : path.join(/* turbopackIgnore: true */ process.cwd(), fileHint);
      if (fs.existsSync(resolved)) {
        return fs.readFileSync(resolved, "utf8");
      }
      console.warn("[llm] LLM_KEYS_FILE not found:", resolved);
    } catch (err) {
      console.warn(
        "[llm] failed reading LLM_KEYS_FILE:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  let raw = process.env.LLM_KEYS_JSON;
  if (!raw || raw.trim() === "" || raw.trim() === "{}") {
    return null;
  }
  raw = raw.trim();
  if (
    (raw.startsWith("'") && raw.endsWith("'")) ||
    (raw.startsWith('"') && raw.endsWith('"'))
  ) {
    raw = raw.slice(1, -1);
  }
  return raw;
}

/** Never throws — bad env falls back to local parse. */
export function loadLlmKeys(): LoadedKey[] {
  const raw = readKeysRaw();
  if (!raw) return [];
  try {
    return parseLlmKeysJson(raw);
  } catch (err) {
    console.warn(
      "[llm] LLM keys JSON invalid — using local parser only.",
      err instanceof Error ? err.message : err,
    );
    return [];
  }
}

/** Build ordered attempt list: preferred platforms first, then any other known ones present in keys. */
export function buildProviderChain(keys: LoadedKey[]): Array<{
  endpoint: ProviderEndpoint;
  apiKeys: string[];
}> {
  const byPlatform = new Map<string, string[]>();
  for (const { platform, key } of keys) {
    const list = byPlatform.get(platform) ?? [];
    list.push(key);
    byPlatform.set(platform, list);
  }

  const seen = new Set<string>();
  const chain: Array<{ endpoint: ProviderEndpoint; apiKeys: string[] }> = [];

  const push = (platform: string) => {
    if (seen.has(platform)) return;
    const apiKeys = byPlatform.get(platform);
    const endpoint = PLATFORM_REGISTRY[platform];
    if (!apiKeys?.length || !endpoint) return;
    seen.add(platform);
    chain.push({ endpoint, apiKeys });
  };

  for (const platform of PREFERRED_ORDER) push(platform);
  for (const platform of byPlatform.keys()) push(platform);

  return chain;
}

export function listUnsupportedPlatforms(keys: LoadedKey[]): string[] {
  const unsupported = new Set<string>();
  for (const { platform } of keys) {
    if (!PLATFORM_REGISTRY[platform]) unsupported.add(platform);
  }
  return [...unsupported];
}

/** @deprecated alias — router used ProviderId historically */
export type ProviderId = PlatformId;
