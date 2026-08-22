/**
 * Theme infrastructure (test-drive note 4).
 *
 * Three theme MODES: 'system' (follow the OS via prefers-color-scheme),
 * 'light', 'dark'. The mode persists in localStorage under 'fplan-theme';
 * the RESOLVED theme ('light' | 'dark') is stamped as `data-theme` on <html>
 * (index.html stamps it pre-paint; useThemeController keeps it in sync).
 * All CSS colors come from custom properties defined in styles.css under
 * `:root` (light) and `:root[data-theme='dark']`.
 *
 * ============================== FOR PAGES ==================================
 * Chart components (Recharts) cannot use CSS variables for everything
 * (fill/stroke props sometimes end up in contexts where var() resolution is
 * unreliable, and opacities need numbers), so they should call:
 *
 *     const chart = useChartTheme();   // returns ChartPalette (below)
 *
 * inside any component rendered under App's ThemeContext.Provider. The hook
 * re-renders the component whenever the active theme changes (manual toggle
 * or an OS-level change while in 'system' mode) and returns concrete color
 * strings. Mapping from the previously hardcoded colors:
 *
 *     '#2563eb' (primary lines)              -> chart.accent
 *     '#e5e8ee' / var(--border) (grid)       -> chart.grid
 *     axis ticks/lines                       -> chart.axis
 *       e.g. <XAxis stroke={chart.axis} tick={{ fill: chart.axis }} />
 *     tooltip container                      -> chart.tooltip.{bg,border,text}
 *     '#15803d' / '#059669' (greens)         -> chart.good
 *     '#b45309' (dark amber)                 -> chart.warn
 *     '#b91c1c' (reds)                       -> chart.bad
 *     '#f59e0b' (bright amber)               -> chart.amber
 *     '#7c3aed' (violet)                     -> chart.violet
 *     '#0d9488' (teal)                       -> chart.teal
 *     '#9ca3af' (light gray refs)            -> chart.neutral
 *     '#6b7280' (dark gray refs)             -> chart.neutralStrong
 *     fan bands '#dbeafe' / '#93c5fd'        -> chart.fan.outerFill/@outerOpacity,
 *                                               chart.fan.innerFill/@innerOpacity
 *     single-series Area fill '#93c5fd'      -> chart.areaFill + chart.areaOpacity
 *     multi-scenario overlays                -> chart.series[i % chart.series.length]
 *     one measure drawn twice (A vs B)       -> chart.duo.primary / .counterfactual
 *       NOT series[0]/series[1] — see the note on `duo` below; that pair is
 *       invisible under deuteranopia.
 * ===========================================================================
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

// ---------------------------------------------------------------------------
// Modes (pure logic — unit-tested in tests/ui/theme.test.ts)
// ---------------------------------------------------------------------------

export type ThemeMode = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'fplan-theme';

/** Parse a stored/unknown value into a ThemeMode; anything unrecognized -> 'system'. */
export function parseThemeMode(raw: unknown): ThemeMode {
  return raw === 'light' || raw === 'dark' || raw === 'system' ? raw : 'system';
}

/** Resolve a mode to the concrete theme, given the OS preference. */
export function resolveTheme(mode: ThemeMode, systemPrefersDark: boolean): ResolvedTheme {
  if (mode === 'system') return systemPrefersDark ? 'dark' : 'light';
  return mode;
}

/** Toggle cycle: System -> Light -> Dark -> System. */
export function nextThemeMode(mode: ThemeMode): ThemeMode {
  switch (mode) {
    case 'system':
      return 'light';
    case 'light':
      return 'dark';
    case 'dark':
      return 'system';
  }
}

export function themeModeLabel(mode: ThemeMode): string {
  switch (mode) {
    case 'system':
      return 'System';
    case 'light':
      return 'Light';
    case 'dark':
      return 'Dark';
  }
}

/** Small glyph for the topbar toggle button. */
export function themeModeIcon(mode: ThemeMode): string {
  switch (mode) {
    case 'system':
      return '◐';
    case 'light':
      return '☀';
    case 'dark':
      return '☾';
  }
}

// ---------------------------------------------------------------------------
// Chart palette (concrete colors for Recharts — see header comment)
// ---------------------------------------------------------------------------

export interface ChartPalette {
  /** The resolved theme this palette belongs to. */
  theme: ResolvedTheme;
  /** Axis lines + tick text: <XAxis stroke={axis} tick={{ fill: axis }} />. */
  axis: string;
  /** CartesianGrid stroke. */
  grid: string;
  /** Custom tooltip container colors. */
  tooltip: { bg: string; border: string; text: string };
  /** Primary series color (median line, solver curve). */
  accent: string;
  /** Categorical palette for multi-series charts (scenario overlays etc.). */
  series: string[];
  good: string;
  warn: string;
  bad: string;
  /** Bright amber (distinct from `warn` in both themes). */
  amber: string;
  violet: string;
  teal: string;
  /** Subtle gray reference lines. */
  neutral: string;
  /** Higher-contrast gray reference lines. */
  neutralStrong: string;
  /** Fan chart bands: outer = p10–p90, inner = p25–p75. */
  fan: {
    outerFill: string;
    outerOpacity: number;
    innerFill: string;
    innerOpacity: number;
  };
  /** Generic single-series Area fill (e.g. solver success band). */
  areaFill: string;
  areaOpacity: number;
  /**
   * A VALIDATED TWO-SERIES PAIR, for a chart drawing the SAME measure twice —
   * the plan as it stands against one counterfactual (the widow chart draws
   * the survivor's odds with the life policy in force and with it dropped).
   *
   * It exists because `series[0]` and `series[1]` — blue and violet — are not
   * safe for that job. Under deuteranopia they collapse:
   *
   *     validate_palette.js "#2563eb,#7c3aed" --mode light --pairs all
   *       [FAIL] CVD separation      #7c3aed↔#2563eb  ΔE 0.4 (deutan)
   *       [FAIL] Normal-vision floor #7c3aed↔#2563eb  ΔE 12.4
   *
   * i.e. a red-green-colorblind reader sees ONE line, and a full-colour reader
   * has to work at it. That is unacceptable for a chart whose entire content is
   * the gap between two lines. These two were picked by running the same
   * validator until every check passed, against the actual card surface each
   * theme paints on (--surface: #ffffff / #1c2431):
   *
   *     light  "#2563eb,#c2410c"  --surface #ffffff  --pairs all → ALL PASS
   *            CVD ΔE 31.7 (protan) · normal-vision ΔE 36.1 · contrast >= 3:1
   *     dark   "#3b82f6,#ea580c"  --surface #1c2431  --pairs all → ALL PASS
   *            CVD ΔE 30.5 (protan) · normal-vision ΔE 36.1 · contrast >= 3:1
   *
   * The dark pair is deliberately NOT `accent`/`amber`: `accent` (#60a5fa) sits
   * above the dark lightness band (L 0.714 vs a 0.48-0.67 ceiling), and while
   * that is fine for a lone median line it fails as half of a compared pair.
   *
   * ANYONE CHANGING THESE MUST RE-RUN THE VALIDATOR. Blue-vs-something is an
   * easy thing to eyeball and get badly wrong — that is how the 0.4 above got
   * shipped.
   */
  duo: {
    /** The plan as it stands. */
    primary: string;
    /** The counterfactual it is being read against. */
    counterfactual: string;
  };
}

/**
 * Static palette maps keyed by resolved theme. Kept as a JS map (rather than
 * getComputedStyle reads) so values are deterministic, testable, and available
 * before styles load.
 */
export const CHART_PALETTES: Record<ResolvedTheme, ChartPalette> = {
  light: {
    theme: 'light',
    axis: '#5b6675',
    grid: '#e5e8ee',
    tooltip: { bg: '#ffffff', border: '#dfe3e8', text: '#1c2430' },
    accent: '#2563eb',
    series: ['#2563eb', '#7c3aed', '#0d9488', '#059669', '#f59e0b', '#b91c1c', '#6b7280'],
    good: '#15803d',
    warn: '#b45309',
    bad: '#b91c1c',
    amber: '#f59e0b',
    violet: '#7c3aed',
    teal: '#0d9488',
    neutral: '#9ca3af',
    neutralStrong: '#6b7280',
    fan: { outerFill: '#dbeafe', outerOpacity: 0.9, innerFill: '#93c5fd', innerOpacity: 0.7 },
    areaFill: '#93c5fd',
    areaOpacity: 0.5,
    duo: { primary: '#2563eb', counterfactual: '#c2410c' },
  },
  dark: {
    theme: 'dark',
    axis: '#94a3b8',
    grid: '#2b3446',
    tooltip: { bg: '#232c3d', border: '#38445a', text: '#e5eaf2' },
    accent: '#60a5fa',
    series: ['#60a5fa', '#a78bfa', '#2dd4bf', '#34d399', '#facc15', '#f87171', '#94a3b8'],
    good: '#4ade80',
    warn: '#f59e0b',
    bad: '#f87171',
    amber: '#facc15',
    violet: '#a78bfa',
    teal: '#2dd4bf',
    neutral: '#64748b',
    neutralStrong: '#94a3b8',
    fan: { outerFill: '#1e3a8a', outerOpacity: 0.45, innerFill: '#3b82f6', innerOpacity: 0.45 },
    areaFill: '#3b82f6',
    areaOpacity: 0.35,
    duo: { primary: '#3b82f6', counterfactual: '#ea580c' },
  },
};

// ---------------------------------------------------------------------------
// Context + hooks
// ---------------------------------------------------------------------------

export interface ThemeContextValue {
  /** The user's chosen mode ('system' until they override). */
  mode: ThemeMode;
  /** What is actually applied right now. */
  resolved: ResolvedTheme;
  /** Concrete chart colors for `resolved` — what useChartTheme() returns. */
  palette: ChartPalette;
  setMode: (mode: ThemeMode) => void;
  /** Advance System -> Light -> Dark -> System (the topbar toggle). */
  cycleMode: () => void;
}

/** Provided by App.tsx at the root; null outside the provider. */
export const ThemeContext = createContext<ThemeContextValue | null>(null);

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error('useTheme() requires <ThemeContext.Provider> (mounted in App)');
  }
  return ctx;
}

/**
 * useChartTheme(): ChartPalette
 *
 * The hook chart components call for Recharts colors. Subscribes to the
 * ThemeContext, so callers re-render (with fresh colors) whenever the active
 * theme changes. See the module header for the color mapping table.
 */
export function useChartTheme(): ChartPalette {
  return useTheme().palette;
}

function loadStoredThemeMode(): ThemeMode {
  try {
    if (typeof localStorage === 'undefined') return 'system';
    return parseThemeMode(localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return 'system';
  }
}

function saveThemeMode(mode: ThemeMode): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    // Private-mode / storage-disabled: theme still works, just not persisted.
  }
}

function systemPrefersDark(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)').matches
    : false;
}

/**
 * State + effects behind the ThemeContext value. Called once by App.tsx,
 * which renders <ThemeContext.Provider value={useThemeController()}>.
 * - loads the persisted mode ('fplan-theme');
 * - listens for OS prefers-color-scheme changes (matters in 'system' mode);
 * - stamps `data-theme` on <html> whenever the resolved theme changes.
 */
export function useThemeController(): ThemeContextValue {
  const [mode, setModeState] = useState<ThemeMode>(loadStoredThemeMode);
  const [systemDark, setSystemDark] = useState<boolean>(systemPrefersDark);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const resolved = resolveTheme(mode, systemDark);

  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.dataset.theme = resolved;
    }
  }, [resolved]);

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next);
    saveThemeMode(next);
  }, []);

  const cycleMode = useCallback(() => {
    setMode(nextThemeMode(mode));
  }, [mode, setMode]);

  return useMemo(
    () => ({ mode, resolved, palette: CHART_PALETTES[resolved], setMode, cycleMode }),
    [mode, resolved, setMode, cycleMode],
  );
}
