"use client";

import { useEffect } from "react";

/**
 * Registers the PWA service worker so the portal can be installed and
 * works offline for cached assets. Only runs in production (dev serves
 * everything on-demand and hot-reloads, which clashes with SW caching).
 */
export default function PwaRegister() {
  useEffect(() => {
    if (
      process.env.NODE_ENV !== "production" ||
      typeof window === "undefined" ||
      !("serviceWorker" in navigator)
    ) {
      return;
    }
    navigator.serviceWorker.register("/sw.js").catch((err) => {
      console.warn("[PWA] Service worker registration failed:", err);
    });
  }, []);

  return null;
}