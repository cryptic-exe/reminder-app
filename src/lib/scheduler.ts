/**
 * Local / long-running Node process scheduler.
 * Skipped on Vercel (use vercel.json cron instead).
 */
let started = false;

export function startLocalScheduler() {
  if (started) return;
  if (process.env.VERCEL) return;
  if (process.env.DISABLE_LOCAL_SCHEDULER === "1") return;

  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.warn(
      "[scheduler] CRON_SECRET missing — local auto-dispatch disabled",
    );
    return;
  }

  started = true;

  const port = process.env.PORT || "3000";
  const base =
    process.env.APP_URL?.replace(/\/$/, "") || `http://127.0.0.1:${port}`;
  const intervalMs = Number(process.env.SCHEDULER_INTERVAL_MS || 10_000);

  console.log(
    `[scheduler] dispatching due reminders every ${intervalMs / 1000}s → ${base}/api/cron/dispatch`,
  );

  const tick = async () => {
    try {
      const res = await fetch(`${base}/api/cron/dispatch`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${secret}`,
          Accept: "application/json",
        },
        cache: "no-store",
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        console.warn(`[scheduler] dispatch HTTP ${res.status}`, body.slice(0, 200));
        return;
      }
      const data = (await res.json()) as { processed?: number };
      if (data.processed && data.processed > 0) {
        console.log(`[scheduler] sent ${data.processed} reminder(s)`);
      }
    } catch (err) {
      // Server may still be booting
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes("ECONNREFUSED")) {
        console.warn("[scheduler] tick failed:", message);
      }
    }
  };

  // Delay first tick so Next finishes booting
  setTimeout(tick, 5_000);
  setInterval(tick, intervalMs);
}
