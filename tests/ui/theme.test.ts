/**
 * Unit tests for the pure theme logic in src/ui/theme.ts (test-drive note 4).
 * All expected values are hand-derived from the documented rules:
 * - mode cycle: system -> light -> dark -> system
 * - resolution: 'system' follows the OS flag; explicit modes ignore it
 * - unknown stored values fall back to 'system'
 * - the light/dark chart palettes are complete, well-formed, and distinct.
 */
import { describe, expect, it } from 'vitest';
import {
  CHART_PALETTES,
  nextThemeMode,
  parseThemeMode,
  resolveTheme,
  themeModeIcon,
  themeModeLabel,
  THEME_STORAGE_KEY,
  type ThemeMode,
} from '../../src/ui/theme';

describe('parseThemeMode', () => {
  it('accepts the three valid modes', () => {
    expect(parseThemeMode('system')).toBe('system');
    expect(parseThemeMode('light')).toBe('light');
    expect(parseThemeMode('dark')).toBe('dark');
  });

  it('falls back to system for anything else', () => {
    // Covers a missing localStorage key (null), stale/corrupt strings, and
    // non-string junk — all must resolve to the default 'system'.
    expect(parseThemeMode(null)).toBe('system');
    expect(parseThemeMode(undefined)).toBe('system');
    expect(parseThemeMode('')).toBe('system');
    expect(parseThemeMode('Dark')).toBe('system'); // case-sensitive by design
    expect(parseThemeMode('auto')).toBe('system');
    expect(parseThemeMode(42)).toBe('system');
  });
});

describe('resolveTheme', () => {
  it('system mode follows the OS preference', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
  });

  it('explicit modes ignore the OS preference', () => {
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('light', false)).toBe('light');
    expect(resolveTheme('dark', true)).toBe('dark');
    expect(resolveTheme('dark', false)).toBe('dark');
  });
});

describe('nextThemeMode', () => {
  it('cycles system -> light -> dark -> system', () => {
    expect(nextThemeMode('system')).toBe('light');
    expect(nextThemeMode('light')).toBe('dark');
    expect(nextThemeMode('dark')).toBe('system');
  });

  it('returns to the start after exactly three clicks from any mode', () => {
    // 3 = cycle length, so f(f(f(x))) = x for each of the three modes.
    for (const mode of ['system', 'light', 'dark'] as ThemeMode[]) {
      expect(nextThemeMode(nextThemeMode(nextThemeMode(mode)))).toBe(mode);
    }
  });
});

describe('mode labels and icons', () => {
  it('labels each mode for the topbar toggle', () => {
    expect(themeModeLabel('system')).toBe('System');
    expect(themeModeLabel('light')).toBe('Light');
    expect(themeModeLabel('dark')).toBe('Dark');
  });

  it('icons are non-empty and distinct per mode', () => {
    const icons = (['system', 'light', 'dark'] as ThemeMode[]).map(themeModeIcon);
    for (const icon of icons) expect(icon.length).toBeGreaterThan(0);
    expect(new Set(icons).size).toBe(3);
  });
});

describe('storage key', () => {
  it('is the documented localStorage key', () => {
    expect(THEME_STORAGE_KEY).toBe('fplan-theme');
  });
});

describe('CHART_PALETTES', () => {
  const HEX = /^#[0-9a-f]{6}$/i;
  const themes = ['light', 'dark'] as const;

  it('tags each palette with its own theme', () => {
    expect(CHART_PALETTES.light.theme).toBe('light');
    expect(CHART_PALETTES.dark.theme).toBe('dark');
  });

  it('every color is a 6-digit hex string (Recharts-safe, no var() refs)', () => {
    for (const theme of themes) {
      const p = CHART_PALETTES[theme];
      const colors = [
        p.axis,
        p.grid,
        p.tooltip.bg,
        p.tooltip.border,
        p.tooltip.text,
        p.accent,
        ...p.series,
        p.good,
        p.warn,
        p.bad,
        p.amber,
        p.violet,
        p.teal,
        p.neutral,
        p.neutralStrong,
        p.fan.outerFill,
        p.fan.innerFill,
        p.areaFill,
      ];
      for (const c of colors) expect(c).toMatch(HEX);
    }
  });

  it('opacities are in (0, 1]', () => {
    for (const theme of themes) {
      const p = CHART_PALETTES[theme];
      for (const o of [p.fan.outerOpacity, p.fan.innerOpacity, p.areaOpacity]) {
        expect(o).toBeGreaterThan(0);
        expect(o).toBeLessThanOrEqual(1);
      }
    }
  });

  it('offers enough categorical series colors and keeps them unique', () => {
    for (const theme of themes) {
      const s = CHART_PALETTES[theme].series;
      // MagiChartCard uses up to 8 line styles from ~5 hues + dashes; overlays
      // need at least a handful of distinct hues. 7 chosen per theme.
      expect(s.length).toBeGreaterThanOrEqual(5);
      expect(new Set(s.map((c) => c.toLowerCase())).size).toBe(s.length);
    }
  });

  it('warn and amber stay distinguishable within each theme', () => {
    // They render as separate dashed threshold lines on the MAGI chart.
    for (const theme of themes) {
      const p = CHART_PALETTES[theme];
      expect(p.warn.toLowerCase()).not.toBe(p.amber.toLowerCase());
    }
  });

  it('light and dark palettes actually differ where it matters', () => {
    const l = CHART_PALETTES.light;
    const d = CHART_PALETTES.dark;
    expect(l.accent).not.toBe(d.accent);
    expect(l.grid).not.toBe(d.grid);
    expect(l.axis).not.toBe(d.axis);
    expect(l.tooltip.bg).not.toBe(d.tooltip.bg);
    expect(l.fan.outerFill).not.toBe(d.fan.outerFill);
  });
});
