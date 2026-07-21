import { CssBaseline, ThemeProvider } from "@mui/material";
import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";
import { type ColorMode, createAppTheme } from "./theme";

/** User preference: an explicit mode, or "system" (follow the OS setting). */
export type ColorModePref = ColorMode | "system";

interface ColorModeContextValue {
  /** The resolved, active mode (after applying "system"). */
  mode: ColorMode;
  /** The stored user preference. */
  pref: ColorModePref;
  setPref: (pref: ColorModePref) => void;
}

const ColorModeContext = createContext<ColorModeContextValue | null>(null);

const STORAGE_KEY = "ct.colorMode";

function systemMode(): ColorMode {
  return typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function readStoredPref(): ColorModePref {
  try {
    const s = localStorage.getItem(STORAGE_KEY);
    if (s === "light" || s === "dark" || s === "system") return s;
  } catch {
    // localStorage unavailable (private mode / SSR) — fall through to default.
  }
  return "system";
}

/**
 * Owns the app's color mode: a persisted user preference (light / dark / system),
 * resolved to an active mode, and the MUI ThemeProvider + CssBaseline built from it.
 * Wrap the app in this once (see main.tsx); toggle via {@link useColorMode}.
 */
export function ColorModeProvider({ children }: { children: ReactNode }) {
  const [pref, setPrefState] = useState<ColorModePref>(readStoredPref);
  const [sysMode, setSysMode] = useState<ColorMode>(systemMode);

  // Track OS theme changes while the preference is "system".
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setSysMode(mq.matches ? "dark" : "light");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const mode: ColorMode = pref === "system" ? sysMode : pref;

  const value = useMemo<ColorModeContextValue>(
    () => ({
      mode,
      pref,
      setPref: (next) => {
        setPrefState(next);
        try {
          localStorage.setItem(STORAGE_KEY, next);
        } catch {
          // Persistence is best-effort; the in-memory preference still applies.
        }
      },
    }),
    [mode, pref],
  );

  const theme = useMemo(() => createAppTheme(mode), [mode]);

  return (
    <ColorModeContext.Provider value={value}>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        {children}
      </ThemeProvider>
    </ColorModeContext.Provider>
  );
}

export function useColorMode(): ColorModeContextValue {
  const ctx = useContext(ColorModeContext);
  if (!ctx) throw new Error("useColorMode must be used within a ColorModeProvider");
  return ctx;
}
