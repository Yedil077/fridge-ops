"use client";

import { useEffect } from "react";

/** Registers the service worker in production only (in dev it would cache hot-reloaded code). */
export function PwaRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").catch(() => {
      /* not critical — the app works without it */
    });
  }, []);
  return null;
}
