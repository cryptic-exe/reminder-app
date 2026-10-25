"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Login failed");
      router.replace("/");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="flex flex-1 items-center justify-center px-4 py-16">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-sm rounded-2xl border border-zinc-200 bg-white/80 p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-950/70"
      >
        <p className="text-xs font-medium uppercase tracking-[0.2em] text-teal-700 dark:text-teal-300">
          Reminder
        </p>
        <h1 className="mt-2 text-2xl font-semibold text-zinc-900 dark:text-zinc-50">
          Enter password
        </h1>
        <p className="mt-1 text-sm text-zinc-500">
          Single-user access for your WhatsApp reminders.
        </p>
        <input
          type="password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          className="mt-6 w-full rounded-xl border border-zinc-200 bg-white px-3 py-2.5 outline-none ring-teal-600/30 focus:ring-2 dark:border-zinc-700 dark:bg-zinc-900"
        />
        {error && (
          <p className="mt-3 text-sm text-red-600 dark:text-red-300">{error}</p>
        )}
        <button
          type="submit"
          disabled={loading || !password}
          className="mt-4 w-full rounded-xl bg-teal-700 py-2.5 text-sm font-medium text-white hover:bg-teal-800 disabled:opacity-40"
        >
          {loading ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </main>
  );
}
