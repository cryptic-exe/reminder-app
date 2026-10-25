import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "app.reminder.whatsapp",
  appName: "Reminder",
  webDir: "public",
  server: {
    // Point the native shell at your deployed Next.js app (or local IP while developing).
    // After first deploy, set this to https://your-app.vercel.app
    url: process.env.CAPACITOR_SERVER_URL || "http://localhost:3000",
    cleartext: true,
  },
  android: {
    allowMixedContent: true,
  },
};

export default config;
