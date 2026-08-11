"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

type Theme = "light" | "dark" | "system";

interface ThemeContextValue {
  theme: Theme;
  setTheme: (t: Theme) => void;
  resolved: "light" | "dark";
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: "dark",
  setTheme: () => {},
  resolved: "dark",
});

export function useTheme() {
  return useContext(ThemeContext);
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>("dark");
  const [resolved, setResolved] = useState<"light" | "dark">("dark");

  // Load from localStorage on mount
  useEffect(() => {
    const stored = localStorage.getItem("theme") as Theme | null;
    if (stored) setThemeState(stored);
  }, []);

  // Apply theme class to <html>
  useEffect(() => {
    const root = document.documentElement;

    const resolve = (t: Theme): "light" | "dark" => {
      if (t === "system") {
        return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
      }
      return t;
    };

    const apply = (t: Theme) => {
      const r = resolve(t);
      setResolved(r);
      root.classList.remove("light", "dark");
      root.classList.add(r);

      // Set CSS custom properties for theme-aware colors
      if (r === "light") {
        root.style.setProperty("--background", "#f8f9fa");
        root.style.setProperty("--foreground", "#1a1a2e");
        root.style.setProperty("--surface-bg", "rgba(0,0,0,0.02)");
        root.style.setProperty("--surface-border", "rgba(0,0,0,0.08)");
        root.style.setProperty("--text-primary", "#1a1a2e");
        root.style.setProperty("--text-secondary", "rgba(0,0,0,0.55)");
        root.style.setProperty("--text-muted", "rgba(0,0,0,0.35)");
        root.style.setProperty("--input-bg", "rgba(0,0,0,0.04)");
        root.style.setProperty("--input-border", "rgba(0,0,0,0.12)");
        root.style.setProperty("--input-focus-border", "rgba(99,91,255,0.6)");
      } else {
        root.style.setProperty("--background", "#07070d");
        root.style.setProperty("--foreground", "#f4f4f8");
        root.style.setProperty("--surface-bg", "rgba(255,255,255,0.02)");
        root.style.setProperty("--surface-border", "rgba(255,255,255,0.06)");
        root.style.setProperty("--text-primary", "#f4f4f8");
        root.style.setProperty("--text-secondary", "rgba(255,255,255,0.45)");
        root.style.setProperty("--text-muted", "rgba(255,255,255,0.25)");
        root.style.setProperty("--input-bg", "rgba(255,255,255,0.04)");
        root.style.setProperty("--input-border", "rgba(255,255,255,0.10)");
        root.style.setProperty("--input-focus-border", "rgba(139,133,255,0.7)");
      }
    };

    apply(theme);
    localStorage.setItem("theme", theme);

    // Listen for system changes when in system mode
    if (theme === "system") {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      const handler = () => apply("system");
      mq.addEventListener("change", handler);
      return () => mq.removeEventListener("change", handler);
    }
  }, [theme]);

  function setTheme(t: Theme) {
    setThemeState(t);
  };

  return (
    <ThemeContext.Provider value={{ theme, setTheme, resolved }}>
      {children}
    </ThemeContext.Provider>
  );
}
