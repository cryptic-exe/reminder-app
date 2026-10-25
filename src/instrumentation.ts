export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { startLocalScheduler } = await import("@/lib/scheduler");
  const { startWahaEventListener } = await import("@/lib/waha-events");
  startLocalScheduler();
  startWahaEventListener();
}
