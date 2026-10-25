import { prisma } from "@/lib/db";

const FINGERPRINT_TTL_MS = 90_000;

/**
 * Atomically claim a key in Postgres.
 * Returns true if this caller won the claim (first writer).
 */
async function claimKey(key: string): Promise<boolean> {
  const normalized = key.trim();
  if (!normalized) return true;
  try {
    await prisma.inboundClaim.create({ data: { key: normalized } });
    return true;
  } catch (err) {
    const code =
      err && typeof err === "object" && "code" in err
        ? String((err as { code: unknown }).code)
        : "";
    if (code === "P2002") return false; // unique violation
    console.warn("[inbound-dedupe] claim failed:", err);
    // Fail open only if DB is broken — prefer fail closed for duplicates
    return false;
  }
}

/** Returns true if this message id was newly claimed (false if already seen). */
export async function claimMessageId(
  id: string | null | undefined,
): Promise<boolean> {
  if (!id) return true;
  return claimKey(`id:${id}`);
}

/** Returns true if this text was newly claimed (false if handled recently). */
export async function claimFingerprint(text: string): Promise<boolean> {
  const key = text.trim().toLowerCase().replace(/\s+/g, " ");
  if (!key) return true;
  // Include minute bucket so TTL-ish behavior without deletes every time
  const bucket = Math.floor(Date.now() / FINGERPRINT_TTL_MS);
  return claimKey(`fp:${bucket}:${key.slice(0, 200)}`);
}

/** Best-effort cleanup of old claims (optional; table stays small). */
export async function pruneInboundClaims(): Promise<void> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60_000);
  await prisma.inboundClaim
    .deleteMany({ where: { createdAt: { lt: cutoff } } })
    .catch(() => undefined);
}
