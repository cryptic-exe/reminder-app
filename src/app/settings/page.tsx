import { SettingsApp } from "@/components/SettingsApp";

export default function SettingsPage() {
  return (
    <main className="relative flex flex-1 flex-col">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_top,_rgba(15,118,110,0.18),_transparent_55%),linear-gradient(180deg,#f8faf9_0%,#eef2f0_100%)] dark:bg-[radial-gradient(ellipse_at_top,_rgba(45,212,191,0.12),_transparent_50%),linear-gradient(180deg,#09090b_0%,#0c1210_100%)]"
      />
      <SettingsApp />
    </main>
  );
}
