"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

type SessionInfo = {
  name: string;
  status: string;
  me: { id?: string; pushName?: string } | null;
  engine?: { engine?: string } | null;
};

type StatusPayload = {
  configured: boolean;
  baseUrl: string;
  sessionName: string;
  chatIdEnv: string | null;
  session: SessionInfo | null;
};

function statusTone(status: string | undefined) {
  switch (status) {
    case "WORKING":
      return "bg-teal-100 text-teal-900 dark:bg-teal-950/50 dark:text-teal-100";
    case "SCAN_QR_CODE":
      return "bg-amber-100 text-amber-900 dark:bg-amber-950/40 dark:text-amber-100";
    case "FAILED":
      return "bg-red-100 text-red-900 dark:bg-red-950/40 dark:text-red-100";
    case "STARTING":
      return "bg-sky-100 text-sky-900 dark:bg-sky-950/40 dark:text-sky-100";
    default:
      return "bg-zinc-100 text-zinc-700 dark:bg-zinc-900 dark:text-zinc-200";
  }
}

export function WhatsAppSetup() {
  const [status, setStatus] = useState<StatusPayload | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [pairingPhone, setPairingPhone] = useState("");
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refreshStatus = useCallback(async () => {
    const res = await fetch("/api/waha/session");
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to load WAHA status");
    setStatus(data);
    return data as StatusPayload;
  }, []);

  const refreshQr = useCallback(async () => {
    const res = await fetch("/api/waha/qr");
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to load QR");
    if (data.data) {
      const mime = data.mimetype || "image/png";
      setQrDataUrl(`data:${mime};base64,${data.data}`);
    } else {
      setQrDataUrl(null);
      throw new Error("QR payload missing image data — restart the session");
    }
  }, []);

  const runAction = async (
    action: "start" | "stop" | "restart" | "logout" | "ensure",
  ) => {
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/waha/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Action ${action} failed`);
      setNotice(`Session ${action} OK`);
      await refreshStatus();
      if (action === "start" || action === "restart" || action === "ensure") {
        // Give WAHA a moment to emit SCAN_QR_CODE
        await new Promise((r) => setTimeout(r, 800));
        const next = await refreshStatus();
        if (next.session?.status === "SCAN_QR_CODE") {
          await refreshQr();
        }
      }
      if (action === "logout" || action === "stop") {
        setQrDataUrl(null);
        setPairingCode(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refreshStatus().catch((err) =>
      setError(err instanceof Error ? err.message : "Failed to load status"),
    );
  }, [refreshStatus]);

  // Poll while pairing
  useEffect(() => {
    const sessionStatus = status?.session?.status;
    if (!sessionStatus) return;
    if (sessionStatus === "WORKING" || sessionStatus === "STOPPED") return;

    const id = setInterval(() => {
      refreshStatus()
        .then(async (next) => {
          if (next.session?.status === "SCAN_QR_CODE") {
            try {
              await refreshQr();
            } catch {
              /* QR may briefly be unavailable */
            }
          }
          if (next.session?.status === "WORKING") {
            setQrDataUrl(null);
            setNotice("WhatsApp connected.");
          }
        })
        .catch(() => {
          /* ignore transient poll errors */
        });
    }, 4000);

    return () => clearInterval(id);
  }, [status?.session?.status, refreshStatus, refreshQr]);

  async function requestPairingCode(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      const startRes = await fetch("/api/waha/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "start" }),
      });
      const startData = await startRes.json();
      if (!startRes.ok) {
        throw new Error(startData.error || "Could not start session");
      }
      await refreshStatus();

      const res = await fetch("/api/waha/pairing-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phoneNumber: pairingPhone }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Pairing code failed");
      setPairingCode(data.code);
      setNotice(
        "Enter this code in WhatsApp → Linked devices → Link with phone number.",
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Pairing failed");
    } finally {
      setLoading(false);
    }
  }

  async function sendTest() {
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/waha/test", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Test failed");
      setNotice("Test WhatsApp message sent.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Test failed");
    } finally {
      setLoading(false);
    }
  }

  const session = status?.session;
  const linkedId = session?.me?.id;

  return (
    <div className="mx-auto flex w-full max-w-xl flex-1 flex-col gap-6 px-4 py-8">
      <header className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-medium uppercase tracking-[0.2em] text-teal-700/80 dark:text-teal-300/80">
            Setup
          </p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            WhatsApp (WAHA)
          </h1>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            Start a session, scan the QR, then set your chat id.
          </p>
        </div>
        <Link
          href="/"
          className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-900"
        >
          Back
        </Link>
      </header>

      {(error || notice) && (
        <div
          className={`rounded-xl px-4 py-3 text-sm ${
            error
              ? "bg-red-50 text-red-800 dark:bg-red-950/50 dark:text-red-200"
              : "bg-teal-50 text-teal-900 dark:bg-teal-950/40 dark:text-teal-100"
          }`}
        >
          {error || notice}
        </div>
      )}

      <section className="rounded-2xl border border-zinc-200/80 bg-white/70 p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-950/60">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">
          Connection
        </h2>
        <dl className="mt-3 space-y-2 text-sm">
          <div className="flex justify-between gap-4">
            <dt className="text-zinc-500">WAHA URL</dt>
            <dd className="truncate font-medium text-zinc-900 dark:text-zinc-100">
              {status?.baseUrl || "—"}
            </dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-zinc-500">Session</dt>
            <dd className="font-medium">{status?.sessionName || "—"}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-zinc-500">Status</dt>
            <dd>
              <span
                className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${statusTone(session?.status)}`}
              >
                {session?.status || "not created"}
              </span>
            </dd>
          </div>
          {session?.engine?.engine && (
            <div className="flex justify-between gap-4">
              <dt className="text-zinc-500">Engine</dt>
              <dd className="font-medium">{session.engine.engine}</dd>
            </div>
          )}
          {linkedId && (
            <div className="flex justify-between gap-4">
              <dt className="text-zinc-500">Linked as</dt>
              <dd className="font-medium">{session?.me?.pushName || linkedId}</dd>
            </div>
          )}
          <div className="flex justify-between gap-4">
            <dt className="text-zinc-500">WHATSAPP_CHAT_ID</dt>
            <dd className="truncate font-mono text-xs">
              {status?.chatIdEnv || "not set"}
            </dd>
          </div>
        </dl>

        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={loading}
            onClick={() => runAction("start")}
            className="rounded-xl bg-teal-700 px-3 py-2 text-sm font-medium text-white disabled:opacity-40"
          >
            Start
          </button>
          <button
            type="button"
            disabled={loading}
            onClick={() => runAction("restart")}
            className="rounded-xl border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 disabled:opacity-40"
          >
            Restart
          </button>
          <button
            type="button"
            disabled={loading}
            onClick={() => runAction("stop")}
            className="rounded-xl border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 disabled:opacity-40"
          >
            Stop
          </button>
          <button
            type="button"
            disabled={loading}
            onClick={() => runAction("logout")}
            className="rounded-xl border border-red-300 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:text-red-300 disabled:opacity-40"
          >
            Logout
          </button>
          <button
            type="button"
            disabled={loading}
            onClick={() => refreshStatus().catch((e) => setError(String(e.message || e)))}
            className="rounded-xl border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 disabled:opacity-40"
          >
            Refresh
          </button>
        </div>
      </section>

      <section className="rounded-2xl border border-zinc-200/80 bg-white/70 p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-950/60">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">
          Scan QR
        </h2>
        <p className="mt-1 text-sm text-zinc-500">
          WhatsApp → Linked devices → Link a device. QR expires quickly; we refresh while status is{" "}
          <code className="text-xs">SCAN_QR_CODE</code>.
        </p>

        <div className="mt-4 flex flex-col items-center gap-3">
          {qrDataUrl ? (
            <img
              src={qrDataUrl}
              alt="WhatsApp QR code"
              width={224}
              height={224}
              className="h-56 w-56 rounded-xl border border-zinc-200 bg-white p-2 dark:border-zinc-700"
            />
          ) : (
            <div className="flex h-56 w-56 items-center justify-center rounded-xl border border-dashed border-zinc-300 text-center text-sm text-zinc-400 dark:border-zinc-700">
              {session?.status === "WORKING"
                ? "Already linked"
                : "Start session to show QR"}
            </div>
          )}
          <button
            type="button"
            disabled={loading || session?.status === "WORKING"}
            onClick={() =>
              refreshQr().catch((err) =>
                setError(err instanceof Error ? err.message : "QR failed"),
              )
            }
            className="rounded-xl border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 disabled:opacity-40"
          >
            Reload QR
          </button>
        </div>
      </section>

      <section className="rounded-2xl border border-zinc-200/80 bg-white/70 p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-950/60">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">
          Pairing code
        </h2>
        <p className="mt-1 text-sm text-zinc-500">
          Alternative to QR. International digits only, no +. Fallback if QR fails.
        </p>
        <form onSubmit={requestPairingCode} className="mt-3 flex flex-wrap gap-2">
          <input
            value={pairingPhone}
            onChange={(e) => setPairingPhone(e.target.value)}
            placeholder="91XXXXXXXXXX"
            className="min-w-[12rem] flex-1 rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          />
          <button
            type="submit"
            disabled={loading || !pairingPhone.trim()}
            className="rounded-xl bg-teal-700 px-3 py-2 text-sm font-medium text-white disabled:opacity-40"
          >
            Get code
          </button>
        </form>
        {pairingCode && (
          <p className="mt-3 text-center font-mono text-2xl tracking-widest text-zinc-900 dark:text-zinc-50">
            {pairingCode}
          </p>
        )}
      </section>

      {session?.status === "WORKING" && (
        <section className="rounded-2xl border border-teal-200 bg-teal-50/70 p-4 dark:border-teal-900 dark:bg-teal-950/30">
          <h2 className="text-sm font-semibold text-teal-900 dark:text-teal-100">
            Almost done
          </h2>
          <p className="mt-2 text-sm text-teal-900/80 dark:text-teal-100/80">
            Set <code className="text-xs">WHATSAPP_CHAT_ID</code> in{" "}
            <code className="text-xs">.env</code> to the number that should receive
            reminders
            {linkedId ? (
              <>
                {" "}
                (linked account is <code className="text-xs">{linkedId}</code> — for
                self-reminders use that same id)
              </>
            ) : null}
            , then restart the dev server / redeploy.
          </p>
          <p className="mt-2 font-mono text-xs text-teal-900 dark:text-teal-100">
            WHATSAPP_CHAT_ID=&quot;{linkedId || "91XXXXXXXXXX@c.us"}&quot;
          </p>
          <button
            type="button"
            disabled={loading || !status?.chatIdEnv}
            onClick={sendTest}
            className="mt-3 rounded-xl bg-teal-700 px-3 py-2 text-sm font-medium text-white disabled:opacity-40"
          >
            Send test message
          </button>
          {!status?.chatIdEnv && (
            <p className="mt-2 text-xs text-teal-800/70 dark:text-teal-200/70">
              Test is disabled until WHATSAPP_CHAT_ID is set.
            </p>
          )}
        </section>
      )}

      <p className="text-xs text-zinc-400">
        Docs:{" "}
        <a
          href="https://waha.devlike.pro/docs/how-to/sessions/"
          target="_blank"
          rel="noreferrer"
          className="underline"
        >
          Sessions
        </a>{" "}
        ·{" "}
        <a
          href="https://waha.devlike.pro/swagger/"
          target="_blank"
          rel="noreferrer"
          className="underline"
        >
          Swagger
        </a>
      </p>
    </div>
  );
}
