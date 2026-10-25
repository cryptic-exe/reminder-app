import { mkdir, readFile, writeFile } from "fs/promises";
import path from "path";

type Store = {
  seenIds: string[];
  /** rawInput fingerprints recently handled */
  fingerprints: Array<{ key: string; at: number }>;
};

/** Vercel serverless filesystem is read-only except /tmp. */
function dataDir(): string {
  if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) {
    return path.join("/tmp", "reminder-data");
  }
  return path.join(process.cwd(), ".data");
}

function storeFile(): string {
  return path.join(dataDir(), "inbound-dedupe.json");
}

const MAX_IDS = 300;
const FINGERPRINT_TTL_MS = 90_000;

async function load(): Promise<Store> {
  try {
    const raw = await readFile(storeFile(), "utf8");
    const parsed = JSON.parse(raw) as Store;
    return {
      seenIds: Array.isArray(parsed.seenIds) ? parsed.seenIds : [],
      fingerprints: Array.isArray(parsed.fingerprints) ? parsed.fingerprints : [],
    };
  } catch {
    return { seenIds: [], fingerprints: [] };
  }
}

async function save(store: Store): Promise<void> {
  const dir = dataDir();
  await mkdir(dir, { recursive: true });
  await writeFile(storeFile(), JSON.stringify(store), "utf8");
}

/** Returns true if this message id was newly claimed (false if already seen). */
export async function claimMessageId(id: string | null | undefined): Promise<boolean> {
  if (!id) return true; // no id → allow (fingerprint may still catch)
  const store = await load();
  if (store.seenIds.includes(id)) return false;
  store.seenIds.push(id);
  if (store.seenIds.length > MAX_IDS) {
    store.seenIds = store.seenIds.slice(-MAX_IDS);
  }
  await save(store);
  return true;
}

/** Returns true if this text was newly claimed (false if handled recently). */
export async function claimFingerprint(text: string): Promise<boolean> {
  const key = text.trim().toLowerCase().replace(/\s+/g, " ");
  if (!key) return true;
  const store = await load();
  const now = Date.now();
  store.fingerprints = store.fingerprints.filter(
    (f) => now - f.at < FINGERPRINT_TTL_MS,
  );
  if (store.fingerprints.some((f) => f.key === key)) {
    await save(store);
    return false;
  }
  store.fingerprints.push({ key, at: now });
  await save(store);
  return true;
}
