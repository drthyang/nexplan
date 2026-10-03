/**
 * The working session (structure, beam settings, orientation, instrument and
 * plan), saved in this browser's localStorage so a reload picks up where the
 * user left off. Nothing leaves the browser. Storage can be unavailable or full
 * (private windows, blocked site data), so every access is guarded and the app
 * works without it. A CIF over MAX_SAVED_CIF characters is not saved.
 */

const KEY = "nexplan-session";
const VERSION = 1;
export const MAX_SAVED_CIF = 2_000_000;

export interface SavedSession {
  readonly tab?: string;
  readonly file?: { readonly name: string; readonly text: string };
  readonly blockName?: string;
  readonly chosenSetting?: string;
  readonly overrides?: Record<string, string>;
  readonly xrayIons?: Record<string, string>;
  readonly radiation?: string;
  readonly neutronMode?: string;
  readonly wavelength?: number;
  readonly tof?: Record<string, unknown>;
  readonly dMin?: number;
  readonly polarization?: Record<string, unknown>;
  readonly axis?: string;
  readonly cwProfile?: Record<string, unknown>;
  readonly ub?: Record<string, unknown>;
  readonly gonio?: Record<string, unknown>;
  readonly experiment?: Record<string, unknown>;
}

export function loadSession(): SavedSession | undefined {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as { v?: number; s?: SavedSession };
    return parsed && parsed.v === VERSION && parsed.s && typeof parsed.s === "object" ? parsed.s : undefined;
  } catch {
    return undefined;
  }
}

/** Save the session; returns false when storage refused it (the app carries on). */
export function saveSession(s: SavedSession): boolean {
  const session = s.file && s.file.text.length > MAX_SAVED_CIF ? { ...s, file: undefined } : s;
  try {
    localStorage.setItem(KEY, JSON.stringify({ v: VERSION, s: session }));
    return true;
  } catch {
    return false;
  }
}

export function clearSession(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Nothing saved, or storage unavailable: nothing to clear.
  }
}

/** A saved number when it is finite, else the default. */
export const savedNumber = (v: unknown, fallback: number): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

/** A saved string when it is one of `allowed`, else the default. */
export function savedChoice<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

/** A saved object merged over its defaults (new fields keep their defaults). */
export function savedObject<T extends object>(v: unknown, fallback: T): T {
  return v && typeof v === "object" && !Array.isArray(v) ? { ...fallback, ...(v as Partial<T>) } : fallback;
}
