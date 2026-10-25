"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

type ChatTarget = {
  id: string;
  name: string;
  chatId: string;
  isDefault: boolean;
};

export function SettingsApp() {
  const [targets, setTargets] = useState<ChatTarget[]>([]);
  const [name, setName] = useState("");
  const [chatId, setChatId] = useState("");
  const [isDefault, setIsDefault] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [webhookUrl, setWebhookUrl] = useState("");

  const load = useCallback(async () => {
    const res = await fetch("/api/targets");
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to load");
    setTargets(data.targets);
  }, []);

  useEffect(() => {
    load().catch((e) => setError(e.message));
    setWebhookUrl(`${window.location.origin}/api/webhooks/waha`);
  }, [load]);

  async function addTarget(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const res = await fetch("/api/targets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, chatId, isDefault }),
    });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error || "Create failed");
      return;
    }
    setName("");
    setChatId("");
    setIsDefault(false);
    setNotice("Target saved.");
    await load();
  }

  async function remove(id: string) {
    await fetch(`/api/targets/${id}`, { method: "DELETE" });
    await load();
  }

  async function makeDefault(id: string) {
    await fetch(`/api/targets/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isDefault: true }),
    });
    await load();
  }

  return (
    <div className="mx-auto flex w-full max-w-xl flex-1 flex-col gap-6 px-4 py-8">
      <header className="flex items-start justify-between">
        <div>
          <p className="text-sm uppercase tracking-[0.2em] text-teal-700 dark:text-teal-300">
            Settings
          </p>
          <h1 className="mt-1 text-3xl font-semibold">Chat targets & inbound</h1>
        </div>
        <Link href="/" className="text-sm text-teal-700 hover:underline">
          Back
        </Link>
      </header>

      {(error || notice) && (
        <div
          className={`rounded-xl px-4 py-3 text-sm ${
            error ? "bg-red-50 text-red-800" : "bg-teal-50 text-teal-900"
          }`}
        >
          {error || notice}
        </div>
      )}

      <section className="rounded-2xl border border-zinc-200 p-4 dark:border-zinc-800">
        <h2 className="text-sm font-semibold uppercase text-zinc-500">
          WhatsApp targets
        </h2>
        <p className="mt-1 text-sm text-zinc-500">
          Personal number (<code>…@c.us</code>) or group (<code>…@g.us</code>).
        </p>
        <ul className="mt-3 space-y-2">
          {targets.map((t) => (
            <li
              key={t.id}
              className="flex items-center justify-between gap-2 rounded-xl border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-800"
            >
              <div>
                <p className="font-medium">
                  {t.name}{" "}
                  {t.isDefault && (
                    <span className="text-xs text-teal-700">default</span>
                  )}
                </p>
                <p className="font-mono text-xs text-zinc-500">{t.chatId}</p>
              </div>
              <div className="flex gap-2 text-xs">
                {!t.isDefault && (
                  <button type="button" onClick={() => makeDefault(t.id)}>
                    Default
                  </button>
                )}
                <button
                  type="button"
                  className="text-red-600"
                  onClick={() => remove(t.id)}
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
        <form onSubmit={addTarget} className="mt-4 space-y-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name (e.g. Personal, Family)"
            className="w-full rounded-xl border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            required
          />
          <input
            value={chatId}
            onChange={(e) => setChatId(e.target.value)}
            placeholder="91XXXXXXXXXX@c.us or group@g.us"
            className="w-full rounded-xl border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            required
          />
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={isDefault}
              onChange={(e) => setIsDefault(e.target.checked)}
            />
            Default target
          </label>
          <button
            type="submit"
            className="rounded-xl bg-teal-700 px-4 py-2 text-sm font-medium text-white"
          >
            Add target
          </button>
        </form>
      </section>

      <section className="rounded-2xl border border-zinc-200 p-4 dark:border-zinc-800">
        <h2 className="text-sm font-semibold uppercase text-zinc-500">
          Create via WhatsApp
        </h2>
        <p className="mt-1 text-sm text-zinc-500">
          Locally the app listens to WAHA over a WebSocket, so{" "}
          <code className="text-xs">snooze 10</code> works even when you reply
          from the same linked phone. On a public deploy, also set WAHA{" "}
          <code className="text-xs">message.any</code> webhooks here (Bearer /{" "}
          <code className="text-xs">?secret=</code> = CRON_SECRET).
        </p>
        <p className="mt-3 break-all rounded-lg bg-zinc-100 p-2 font-mono text-xs dark:bg-zinc-900">
          {webhookUrl}?secret=YOUR_CRON_SECRET
        </p>
        <p className="mt-2 text-xs text-zinc-500">
          <strong>Reminders group only:</strong> “remind…”, snooze, list, voice
          notes. <strong>Personal DMs</strong> to the WAHA-linked number quietly
          queue a “reply later” ping on your notify phone (OWNER_NOTIFY_CHAT_ID)
          — the other person gets no bot reply.
        </p>
      </section>
    </div>
  );
}
