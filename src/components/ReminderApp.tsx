"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  fromDatetimeLocalValue,
  formatInUserTz,
  toDatetimeLocalValue,
} from "@/lib/time";

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

type ReminderStatus = "pending" | "sending" | "sent" | "failed" | "cancelled";
type RecurrenceType = "none" | "daily" | "weekly";

type Tag = { id: string; name: string; color: string };
type ChatTarget = { id: string; name: string; chatId: string; isDefault: boolean };

type Reminder = {
  id: string;
  title: string;
  body: string | null;
  dueAt: string;
  status: ReminderStatus;
  rawInput: string;
  lastError: string | null;
  createdAt: string;
  sentAt: string | null;
  voicePath?: string | null;
  recurrenceType: RecurrenceType;
  recurrenceWeekdays: number[];
  chatTargetId: string | null;
  chatTarget: ChatTarget | null;
  tags: Tag[];
};

type Draft = {
  /** Set when editing an existing reminder */
  editId?: string | null;
  title: string;
  body: string;
  dueAt: string;
  rawInput: string;
  confidence: number | null;
  recurrenceType: RecurrenceType;
  recurrenceWeekdays: number[];
  tags: string[];
  chatTargetId: string | null;
  status?: ReminderStatus;
  provider?: string;
  model?: string;
};

type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  onresult:
    | ((event: {
        resultIndex: number;
        results: ArrayLike<{ 0: { transcript: string }; isFinal: boolean }>;
      }) => void)
    | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
};

declare global {
  interface Window {
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
    SpeechRecognition?: new () => SpeechRecognitionLike;
  }
}

const STATUS_LABEL: Record<ReminderStatus, string> = {
  pending: "Upcoming",
  sending: "Sending",
  sent: "Sent",
  failed: "Failed",
  cancelled: "Cancelled",
};

export function ReminderApp({ timezone }: { timezone: string }) {
  const [text, setText] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [targets, setTargets] = useState<ChatTarget[]>([]);
  const [allTags, setAllTags] = useState<Tag[]>([]);
  const [loading, setLoading] = useState(false);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [speechSupported, setSpeechSupported] = useState(false);
  const [view, setView] = useState<"list" | "calendar">("list");
  const [query, setQuery] = useState("");
  const [tagFilter, setTagFilter] = useState<string>("");
  const [calendarMonth, setCalendarMonth] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  /** User wants mic on — browsers often fire onend after a pause even with continuous=true. */
  const wantListenRef = useRef(false);

  useEffect(() => {
    setSpeechSupported(
      Boolean(window.SpeechRecognition || window.webkitSpeechRecognition),
    );
  }, []);

  const loadReminders = useCallback(async () => {
    const params = new URLSearchParams();
    if (query.trim()) params.set("q", query.trim());
    if (tagFilter) params.set("tag", tagFilter);
    const res = await fetch(`/api/reminders?${params}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to load reminders");
    setReminders(data.reminders);
  }, [query, tagFilter]);

  const loadMeta = useCallback(async () => {
    const [t, g] = await Promise.all([
      fetch("/api/targets").then((r) => r.json()),
      fetch("/api/tags").then((r) => r.json()),
    ]);
    if (t.targets) setTargets(t.targets);
    if (g.tags) setAllTags(g.tags);
  }, []);

  const flushDue = useCallback(async () => {
    try {
      await fetch("/api/reminders/dispatch", { method: "POST" });
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    loadMeta().catch(() => undefined);
  }, [loadMeta]);

  useEffect(() => {
    loadReminders().catch((err) =>
      setError(err instanceof Error ? err.message : "Failed to load"),
    );
  }, [loadReminders]);

  useEffect(() => {
    let cancelled = false;
    async function tick() {
      await flushDue();
      if (!cancelled) await loadReminders().catch(() => undefined);
    }
    tick();
    const pollId = setInterval(tick, 15_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      clearInterval(pollId);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [flushDue, loadReminders]);

  useEffect(() => {
    const next = reminders
      .filter((r) => r.status === "pending")
      .map((r) => new Date(r.dueAt).getTime())
      .filter((t) => !Number.isNaN(t))
      .sort((a, b) => a - b)[0];
    if (next == null) return;
    const wait = Math.max(0, next - Date.now()) + 300;
    const id = setTimeout(() => {
      flushDue().then(() => loadReminders().catch(() => undefined));
    }, Math.min(wait, 2_147_000_000));
    return () => clearTimeout(id);
  }, [reminders, flushDue, loadReminders]);

  async function ensurePhoneTarget(digits: string): Promise<string | null> {
    const normalized =
      digits.replace(/\D/g, "").length === 10
        ? `91${digits.replace(/\D/g, "")}`
        : digits.replace(/\D/g, "");
    if (normalized.length < 10) return null;
    const chatId = `${normalized}@c.us`;
    const existing = targets.find(
      (t) => t.chatId === chatId || t.name === normalized,
    );
    if (existing) return existing.id;
    const res = await fetch("/api/targets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: normalized, chatId, isDefault: false }),
    });
    const data = await res.json();
    if (!res.ok) return null;
    const created = data.target as ChatTarget;
    setTargets((prev) => [...prev, created]);
    return created.id;
  }

  async function openDraftFromParse(data: {
    title?: string;
    body?: string | null;
    dueAt: string;
    rawInput: string;
    confidence?: number | null;
    recurrenceType?: RecurrenceType;
    recurrenceWeekdays?: number[];
    tags?: string[];
    targetHint?: string | null;
    provider?: string;
    model?: string;
  }) {
    let chatTargetId: string | null =
      targets.find((t) => t.isDefault)?.id ?? null;
    if (data.targetHint) {
      const hint = String(data.targetHint);
      const hit = targets.find(
        (t) =>
          t.name.toLowerCase().includes(hint.toLowerCase()) ||
          t.chatId.includes(hint.replace(/\D/g, "")),
      );
      if (hit) {
        chatTargetId = hit.id;
      } else if (/^\d{10,15}$/.test(hint.replace(/\D/g, ""))) {
        chatTargetId =
          (await ensurePhoneTarget(hint)) ?? chatTargetId;
      }
    }

    setDraft({
      editId: null,
      title: data.title?.trim() || data.rawInput.slice(0, 80) || "Reminder",
      body: data.body ?? "",
      dueAt: data.dueAt,
      rawInput: data.rawInput,
      confidence: data.confidence ?? null,
      recurrenceType: data.recurrenceType || "none",
      recurrenceWeekdays: data.recurrenceWeekdays || [],
      tags: data.tags || [],
      chatTargetId,
      provider: data.provider,
      model: data.model,
    });
  }

  function beginEdit(reminder: Reminder) {
    setError(null);
    setNotice(null);
    setDraft({
      editId: reminder.id,
      title: reminder.title,
      body: reminder.body ?? "",
      dueAt: reminder.dueAt,
      rawInput: reminder.rawInput,
      confidence: null,
      recurrenceType: reminder.recurrenceType,
      recurrenceWeekdays: reminder.recurrenceWeekdays ?? [],
      tags: reminder.tags.map((t) => t.name),
      chatTargetId: reminder.chatTargetId,
      status: reminder.status,
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  /** Create without waiting for AI — due in 1 hour, editable before save. */
  function handleQuickDraft() {
    const value = text.trim();
    if (!value) {
      setError("Type a reminder first.");
      return;
    }
    setError(null);
    setNotice(null);
    const dueAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    openDraftFromParse({
      title: value.slice(0, 120),
      body: null,
      dueAt,
      rawInput: value,
      confidence: 0.2,
      recurrenceType: "none",
      recurrenceWeekdays: [],
      tags: [],
      provider: "manual",
      model: "quick",
    });
    setNotice("Review time below, then Save. (Skipped AI parse)");
  }

  async function handleParse(e?: React.FormEvent) {
    e?.preventDefault();
    const value = text.trim();
    if (!value) return;
    setLoading(true);
    setError(null);
    setNotice("Parsing… if this takes long, use Quick save instead.");
    try {
      const res = await fetch("/api/parse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: value }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Parse failed");

      await openDraftFromParse(data);
      setNotice(
        data.provider === "local"
          ? "Parsed offline (AI slow). Check the due time / To, then Save."
          : `Parsed via ${data.provider}. Confirm and Save.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Parse failed");
      // Still open a draft so the user can create the reminder
      handleQuickDraft();
      setError(
        `${err instanceof Error ? err.message : "Parse failed"} — opened a Quick draft instead.`,
      );
    } finally {
      setLoading(false);
    }
  }

  async function handleSave() {
    if (!draft) return;
    if (!draft.title.trim()) {
      setError("Title is required");
      return;
    }
    const dueMs = new Date(draft.dueAt).getTime();
    if (Number.isNaN(dueMs)) {
      setError("Pick a valid due date/time");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const payload: Record<string, unknown> = {
        title: draft.title.trim(),
        body: draft.body || null,
        dueAt: draft.dueAt,
        recurrenceType: draft.recurrenceType,
        recurrenceWeekdays: draft.recurrenceWeekdays,
        chatTargetId: draft.chatTargetId || null,
        tags: draft.tags,
      };

      // Re-arm for WhatsApp when editing a past/sent item into the future
      if (
        draft.editId &&
        dueMs > Date.now() &&
        draft.status &&
        draft.status !== "pending" &&
        draft.status !== "sending"
      ) {
        payload.status = "pending";
      }

      const res = draft.editId
        ? await fetch(`/api/reminders/${draft.editId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          })
        : await fetch("/api/reminders", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              ...payload,
              rawInput: draft.rawInput || draft.title,
            }),
          });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Save failed");
      const wasEdit = Boolean(draft.editId);
      setDraft(null);
      setText("");
      if (dueMs <= Date.now()) {
        await flushDue();
        setNotice(
          wasEdit
            ? "Reminder updated and due now — sending via WhatsApp."
            : "Reminder due now — sending via WhatsApp.",
        );
      } else {
        setNotice(wasEdit ? "Reminder updated." : "Reminder saved.");
      }
      await loadReminders();
      await loadMeta();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setLoading(false);
    }
  }

  async function snooze(id: string, minutes: number) {
    setError(null);
    const res = await fetch(`/api/reminders/${id}/snooze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ minutes }),
    });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error || "Snooze failed");
      return;
    }
    setNotice(`Snoozed ${minutes} minutes.`);
    await loadReminders();
  }

  async function updateStatus(id: string, status: ReminderStatus) {
    const res = await fetch(`/api/reminders/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    if (!res.ok) {
      const data = await res.json();
      setError(data.error || "Update failed");
      return;
    }
    await loadReminders();
  }

  async function removeReminder(id: string) {
    if (draft?.editId === id) setDraft(null);
    const res = await fetch(`/api/reminders/${id}`, { method: "DELETE" });
    if (!res.ok) {
      const data = await res.json();
      setError(data.error || "Delete failed");
      return;
    }
    await loadReminders();
  }

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/login";
  }

  function toggleListen() {
    if (listening) {
      wantListenRef.current = false;
      recognitionRef.current?.stop();
      mediaRecorderRef.current?.stop();
      setListening(false);
      return;
    }

    if (speechSupported) {
      const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!Ctor) return;
      const recognition = new Ctor();
      recognition.lang = "en-IN";
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.onresult = (event) => {
        let finalChunk = "";
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const piece = event.results[i]?.[0]?.transcript ?? "";
          if (event.results[i].isFinal && piece) {
            finalChunk += piece;
          }
        }
        if (finalChunk.trim()) {
          setText((prev) =>
            prev ? `${prev.trim()} ${finalChunk.trim()}` : finalChunk.trim(),
          );
        }
      };
      recognition.onerror = (event) => {
        // "aborted" / "no-speech" are normal while waiting; keep listening if user hasn't stopped
        if (event.error === "not-allowed" || event.error === "service-not-allowed") {
          wantListenRef.current = false;
          setListening(false);
          setError(`Mic error: ${event.error}`);
          return;
        }
        if (event.error === "network" || event.error === "audio-capture") {
          wantListenRef.current = false;
          setListening(false);
          setNotice("Web Speech failed — tap Mic again to record for Whisper.");
        }
      };
      recognition.onend = () => {
        if (!wantListenRef.current) {
          setListening(false);
          return;
        }
        // Keep session open until user taps Stop
        try {
          recognition.start();
        } catch {
          wantListenRef.current = false;
          setListening(false);
        }
      };
      recognitionRef.current = recognition;
      wantListenRef.current = true;
      recognition.start();
      setListening(true);
      setNotice("Listening… tap Stop when finished.");
      return;
    }

    // Whisper MediaRecorder path
    startWhisperRecording().catch((err) =>
      setError(err instanceof Error ? err.message : "Mic failed"),
    );
  }

  async function startWhisperRecording() {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const recorder = new MediaRecorder(stream);
    chunksRef.current = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size) chunksRef.current.push(e.data);
    };
    recorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      setListening(false);
      const blob = new Blob(chunksRef.current, { type: "audio/webm" });
      const form = new FormData();
      form.append("audio", blob, "voice.webm");
      setLoading(true);
      try {
        const res = await fetch("/api/transcribe", { method: "POST", body: form });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Transcription failed");
        setText((prev) => (prev ? `${prev.trim()} ${data.text}` : data.text));
        setNotice("Transcribed with Whisper.");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Transcription failed");
      } finally {
        setLoading(false);
      }
    };
    mediaRecorderRef.current = recorder;
    recorder.start();
    setListening(true);
    setNotice("Recording… tap Mic again to stop & transcribe.");
  }

  const upcoming = reminders.filter(
    (r) => r.status === "pending" || r.status === "sending",
  );
  const past = reminders.filter(
    (r) =>
      r.status === "sent" ||
      r.status === "failed" ||
      r.status === "cancelled",
  );

  const calendarDays = useMemo(
    () => buildCalendar(calendarMonth, reminders),
    [calendarMonth, reminders],
  );

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-5 px-4 py-8">
      <header className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-medium uppercase tracking-[0.2em] text-teal-700/80 dark:text-teal-300/80">
            Reminder
          </p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            WhatsApp pings
          </h1>
          <p className="mt-1 text-sm text-zinc-500">{timezone}</p>
        </div>
        <div className="flex flex-col items-end gap-1.5 text-sm">
          <Link href="/settings" className="text-teal-700 hover:underline dark:text-teal-300">
            Settings
          </Link>
          <Link href="/setup/whatsapp" className="text-zinc-600 hover:underline dark:text-zinc-300">
            WhatsApp setup
          </Link>
          <button type="button" onClick={logout} className="text-zinc-500 hover:underline">
            Log out
          </button>
        </div>
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

      <form
        onSubmit={handleParse}
        className="rounded-2xl border border-zinc-200/80 bg-white/70 p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-950/60"
      >
        <label htmlFor="composer" className="text-sm font-medium">
          Say or type a reminder
        </label>
        <textarea
          id="composer"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={3}
          placeholder='e.g. "Every Monday at 9 call mom" or "Remind me tomorrow about rates"'
          className="mt-2 w-full resize-none rounded-xl border border-zinc-200 bg-white px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900"
        />
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={toggleListen}
            disabled={loading}
            title={
              speechSupported
                ? "Dictate with the browser mic"
                : "Record audio and transcribe with Whisper"
            }
            className={`rounded-xl px-4 py-2 text-sm font-medium ${
              listening
                ? "bg-red-600 text-white"
                : "border border-zinc-300 dark:border-zinc-700"
            }`}
          >
            {listening ? "Stop" : "Mic"}
          </button>
          <button
            type="submit"
            disabled={loading || !text.trim()}
            className="rounded-xl bg-teal-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
          >
            {loading ? "Parsing…" : "Parse with AI"}
          </button>
          <button
            type="button"
            disabled={loading || !text.trim()}
            onClick={handleQuickDraft}
            className="rounded-xl border border-zinc-300 px-4 py-2 text-sm font-medium dark:border-zinc-700 disabled:opacity-40"
          >
            Quick save
          </button>
        </div>
        <p className="mt-2 text-xs text-zinc-500">
          Parse fills title/time with AI. Quick save opens confirm with due = 1 hour
          from now (edit before saving).
        </p>
      </form>

      {draft && (
        <section className="space-y-3 rounded-2xl border border-teal-200 bg-teal-50/60 p-4 dark:border-teal-900 dark:bg-teal-950/30">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-teal-800 dark:text-teal-200">
            {draft.editId ? "Edit reminder" : "Confirm"}
          </h2>
          <Field label="Title">
            <input
              value={draft.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900"
            />
          </Field>
          <Field label="Notes">
            <input
              value={draft.body}
              onChange={(e) => setDraft({ ...draft, body: e.target.value })}
              className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900"
            />
          </Field>
          <Field label="Due">
            <input
              type="datetime-local"
              value={toDatetimeLocalValue(draft.dueAt)}
              onChange={(e) => {
                const next = fromDatetimeLocalValue(e.target.value);
                if (next) setDraft({ ...draft, dueAt: next });
              }}
              className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900"
            />
          </Field>
          <Field label="Repeat">
            <select
              value={draft.recurrenceType}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  recurrenceType: e.target.value as RecurrenceType,
                })
              }
              className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900"
            >
              <option value="none">Does not repeat</option>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
            </select>
          </Field>
          {draft.recurrenceType === "weekly" && (
            <div className="flex flex-wrap gap-1">
              {WEEKDAY_LABELS.map((label, i) => {
                const on = draft.recurrenceWeekdays.includes(i);
                return (
                  <button
                    key={label}
                    type="button"
                    onClick={() => {
                      const set = new Set(draft.recurrenceWeekdays);
                      if (on) set.delete(i);
                      else set.add(i);
                      setDraft({
                        ...draft,
                        recurrenceWeekdays: [...set].sort(),
                      });
                    }}
                    className={`rounded-lg px-2 py-1 text-xs ${
                      on
                        ? "bg-teal-700 text-white"
                        : "border border-zinc-300 dark:border-zinc-700"
                    }`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          )}
          <Field label="Tags (comma)">
            <input
              value={draft.tags.join(", ")}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  tags: e.target.value
                    .split(",")
                    .map((t) => t.trim())
                    .filter(Boolean),
                })
              }
              placeholder="work, health"
              className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900"
            />
          </Field>
          <Field label="Send to">
            <select
              value={draft.chatTargetId ?? ""}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  chatTargetId: e.target.value || null,
                })
              }
              className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900"
            >
              <option value="">Default (env / first target)</option>
              {targets.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </Field>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleSave}
              disabled={loading || !draft.title.trim()}
              className="rounded-xl bg-teal-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
            >
              {draft.editId ? "Save changes" : "Save reminder"}
            </button>
            <button type="button" onClick={() => setDraft(null)} className="px-3 text-sm">
              {draft.editId ? "Cancel" : "Discard"}
            </button>
          </div>
        </section>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search…"
          className="min-w-[10rem] flex-1 rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        />
        <select
          value={tagFilter}
          onChange={(e) => setTagFilter(e.target.value)}
          className="rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        >
          <option value="">All tags</option>
          {allTags.map((t) => (
            <option key={t.id} value={t.name}>
              {t.name}
            </option>
          ))}
        </select>
        <div className="flex rounded-xl border border-zinc-200 dark:border-zinc-700">
          <button
            type="button"
            onClick={() => setView("list")}
            className={`px-3 py-2 text-sm ${view === "list" ? "bg-teal-700 text-white" : ""}`}
          >
            List
          </button>
          <button
            type="button"
            onClick={() => setView("calendar")}
            className={`px-3 py-2 text-sm ${view === "calendar" ? "bg-teal-700 text-white" : ""}`}
          >
            Calendar
          </button>
        </div>
      </div>

      {view === "calendar" ? (
        <CalendarView
          month={calendarMonth}
          days={calendarDays}
          timezone={timezone}
          onPrev={() =>
            setCalendarMonth(
              new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() - 1, 1),
            )
          }
          onNext={() =>
            setCalendarMonth(
              new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 1),
            )
          }
          onSnooze={snooze}
        />
      ) : (
        <>
          <ReminderSection
            title="Upcoming"
            items={upcoming}
            empty="No upcoming reminders."
            timezone={timezone}
            editingId={draft?.editId ?? null}
            onEdit={beginEdit}
            onSnooze={snooze}
            onCancel={(id) => updateStatus(id, "cancelled")}
            onRetry={(id) => updateStatus(id, "pending")}
            onDelete={removeReminder}
          />
          <ReminderSection
            title="History"
            items={past}
            empty="No past reminders yet."
            timezone={timezone}
            editingId={draft?.editId ?? null}
            onEdit={beginEdit}
            onSnooze={snooze}
            onCancel={(id) => updateStatus(id, "cancelled")}
            onRetry={(id) => updateStatus(id, "pending")}
            onDelete={removeReminder}
          />
        </>
      )}

    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="text-xs text-zinc-500">{label}</label>
      {children}
    </div>
  );
}

function ReminderSection({
  title,
  items,
  empty,
  timezone,
  editingId,
  onEdit,
  onSnooze,
  onCancel,
  onRetry,
  onDelete,
}: {
  title: string;
  items: Reminder[];
  empty: string;
  timezone: string;
  editingId: string | null;
  onEdit: (reminder: Reminder) => void;
  onSnooze: (id: string, minutes: number) => void;
  onCancel: (id: string) => void;
  onRetry: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <section>
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-500">
        {title}
      </h2>
      {items.length === 0 ? (
        <p className="text-sm text-zinc-400">{empty}</p>
      ) : (
        <ul className="space-y-2">
          {items.map((r) => (
            <ReminderCard
              key={r.id}
              r={r}
              timezone={timezone}
              editing={editingId === r.id}
              onEdit={onEdit}
              onSnooze={onSnooze}
              onCancel={onCancel}
              onRetry={onRetry}
              onDelete={onDelete}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function ReminderCard({
  r,
  timezone,
  editing,
  onEdit,
  onSnooze,
  onCancel,
  onRetry,
  onDelete,
}: {
  r: Reminder;
  timezone: string;
  editing: boolean;
  onEdit: (reminder: Reminder) => void;
  onSnooze: (id: string, minutes: number) => void;
  onCancel: (id: string) => void;
  onRetry: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <li
      className={`rounded-xl border bg-white/80 px-4 py-3 dark:bg-zinc-950/50 ${
        editing
          ? "border-teal-400 dark:border-teal-700"
          : "border-zinc-200 dark:border-zinc-800"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-medium text-zinc-900 dark:text-zinc-50">{r.title}</p>
          {r.body && <p className="mt-0.5 text-sm text-zinc-500">{r.body}</p>}
          <p className="mt-1 text-xs text-zinc-500">
            Due {formatInUserTz(r.dueAt, timezone)} · {STATUS_LABEL[r.status]}
            {r.voicePath ? " · Voice" : ""}
            {r.recurrenceType !== "none" ? ` · ${r.recurrenceType}` : ""}
            {r.chatTarget ? ` · ${r.chatTarget.name}` : ""}
          </p>
          {r.tags.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {r.tags.map((t) => (
                <span
                  key={t.id}
                  className="rounded-full px-2 py-0.5 text-[10px] text-white"
                  style={{ background: t.color }}
                >
                  {t.name}
                </span>
              ))}
            </div>
          )}
          {r.lastError && (
            <p className="mt-1 text-xs text-red-600 dark:text-red-300">{r.lastError}</p>
          )}
        </div>
        <div className="flex shrink-0 flex-col gap-1 text-right text-xs">
          <button
            type="button"
            onClick={() => onEdit(r)}
            className="text-teal-700 dark:text-teal-300"
          >
            {editing ? "Editing…" : "Edit"}
          </button>
          <button type="button" onClick={() => onSnooze(r.id, 10)} className="text-teal-700 dark:text-teal-300">
            Snooze 10m
          </button>
          <button type="button" onClick={() => onSnooze(r.id, 60)} className="text-teal-700 dark:text-teal-300">
            Snooze 1h
          </button>
          {(r.status === "pending" || r.status === "sending") && (
            <button type="button" onClick={() => onCancel(r.id)} className="text-zinc-500">
              Cancel
            </button>
          )}
          {r.status === "failed" && (
            <button type="button" onClick={() => onRetry(r.id)} className="text-teal-700">
              Retry
            </button>
          )}
          <button type="button" onClick={() => onDelete(r.id)} className="text-red-600">
            Delete
          </button>
        </div>
      </div>
    </li>
  );
}

type CalDay = { date: Date; inMonth: boolean; items: Reminder[] };

function buildCalendar(month: Date, reminders: Reminder[]): CalDay[] {
  const year = month.getFullYear();
  const m = month.getMonth();
  const first = new Date(year, m, 1);
  const startPad = first.getDay();
  const start = new Date(year, m, 1 - startPad);
  const days: CalDay[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const key = d.toDateString();
    days.push({
      date: d,
      inMonth: d.getMonth() === m,
      items: reminders.filter((r) => new Date(r.dueAt).toDateString() === key),
    });
  }
  return days;
}

function CalendarView({
  month,
  days,
  timezone,
  onPrev,
  onNext,
  onSnooze,
}: {
  month: Date;
  days: CalDay[];
  timezone: string;
  onPrev: () => void;
  onNext: () => void;
  onSnooze: (id: string, minutes: number) => void;
}) {
  const label = month.toLocaleString("en-US", { month: "long", year: "numeric" });
  return (
    <section className="rounded-2xl border border-zinc-200 p-3 dark:border-zinc-800">
      <div className="mb-3 flex items-center justify-between">
        <button type="button" onClick={onPrev} className="text-sm">
          ←
        </button>
        <h2 className="text-sm font-semibold">{label}</h2>
        <button type="button" onClick={onNext} className="text-sm">
          →
        </button>
      </div>
      <div className="grid grid-cols-7 gap-1 text-center text-[10px] text-zinc-500">
        {WEEKDAY_LABELS.map((d) => (
          <div key={d}>{d}</div>
        ))}
      </div>
      <div className="mt-1 grid grid-cols-7 gap-1">
        {days.map((day) => (
          <div
            key={day.date.toISOString()}
            className={`min-h-16 rounded-lg border p-1 text-left ${
              day.inMonth
                ? "border-zinc-200 dark:border-zinc-800"
                : "border-transparent opacity-40"
            }`}
          >
            <div className="text-[10px] text-zinc-500">{day.date.getDate()}</div>
            {day.items.slice(0, 3).map((r) => (
              <button
                key={r.id}
                type="button"
                title={`${r.title} · ${formatInUserTz(r.dueAt, timezone)}`}
                onClick={() => onSnooze(r.id, 10)}
                className="mt-0.5 block w-full truncate rounded bg-teal-700/90 px-0.5 text-[9px] text-white"
              >
                {r.title}
              </button>
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}
