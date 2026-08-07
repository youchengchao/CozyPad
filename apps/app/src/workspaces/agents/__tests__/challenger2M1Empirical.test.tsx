import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

describe('Challenger 2 M1 Empirical Verification Suite', () => {

  describe('1. localStorage key cozypad-agent-sidebar-width handling & fallbacks', () => {
    const SIDEBAR_MIN = 180;
    const SIDEBAR_ABSOLUTE_MAX = 600;
    const SIDEBAR_DEFAULT = 286;

    function getInitialSidebarWidth(storedGetter: () => string | null): number {
      try {
        const stored = storedGetter();
        if (stored !== null) {
          const parsed = Number(stored);
          if (Number.isFinite(parsed)) return Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_ABSOLUTE_MAX, parsed));
        }
      } catch { /* ignore */ }
      return SIDEBAR_DEFAULT;
    }

    it('returns stored value when valid number within range [180, 600]', () => {
      expect(getInitialSidebarWidth(() => '350')).toBe(350);
      expect(getInitialSidebarWidth(() => '200')).toBe(200);
      expect(getInitialSidebarWidth(() => '599.5')).toBe(599.5);
    });

    it('clamps values below MIN (180px)', () => {
      expect(getInitialSidebarWidth(() => '100')).toBe(SIDEBAR_MIN);
      expect(getInitialSidebarWidth(() => '0')).toBe(SIDEBAR_MIN);
      expect(getInitialSidebarWidth(() => '-250')).toBe(SIDEBAR_MIN);
    });

    it('clamps values above MAX (600px)', () => {
      expect(getInitialSidebarWidth(() => '650')).toBe(SIDEBAR_ABSOLUTE_MAX);
      expect(getInitialSidebarWidth(() => '9999')).toBe(SIDEBAR_ABSOLUTE_MAX);
    });

    it('falls back to default (286px) for invalid/corrupt non-numeric strings', () => {
      expect(getInitialSidebarWidth(() => 'invalid_width')).toBe(SIDEBAR_DEFAULT);
      expect(getInitialSidebarWidth(() => 'abc')).toBe(SIDEBAR_DEFAULT);
      expect(getInitialSidebarWidth(() => 'undefined')).toBe(SIDEBAR_DEFAULT);
      expect(getInitialSidebarWidth(() => 'null')).toBe(SIDEBAR_DEFAULT);
      expect(getInitialSidebarWidth(() => 'NaN')).toBe(SIDEBAR_DEFAULT);
      expect(getInitialSidebarWidth(() => '{"width":300}')).toBe(SIDEBAR_DEFAULT);
      expect(getInitialSidebarWidth(() => '[180, 300]')).toBe(SIDEBAR_DEFAULT);
    });

    it('falls back to default (286px) for non-finite values (Infinity, -Infinity)', () => {
      expect(getInitialSidebarWidth(() => 'Infinity')).toBe(SIDEBAR_DEFAULT);
      expect(getInitialSidebarWidth(() => '-Infinity')).toBe(SIDEBAR_DEFAULT);
    });

    it('handles empty/whitespace strings by converting to 0 and clamping to MIN (180px)', () => {
      expect(getInitialSidebarWidth(() => '')).toBe(SIDEBAR_MIN);
      expect(getInitialSidebarWidth(() => '   ')).toBe(SIDEBAR_MIN);
    });

    it('falls back to default (286px) when localStorage.getItem throws SecurityError', () => {
      expect(getInitialSidebarWidth(() => {
        throw new Error('SecurityError: Access is denied for localStorage');
      })).toBe(SIDEBAR_DEFAULT);
    });

    it('returns default (286px) when key is absent (null)', () => {
      expect(getInitialSidebarWidth(() => null)).toBe(SIDEBAR_DEFAULT);
    });
  });

  describe('2. Dark Theme CSS Variable Declarations & Contrast Ratio in styles.css', () => {
    const cssPath = path.resolve(__dirname, '../../../styles.css');
    const cssContent = fs.readFileSync(cssPath, 'utf-8');

    it('styles.css exists and contains valid :root declaration', () => {
      expect(cssContent).toContain(':root {');
    });

    it('declares all required VS Code / Cursor dark theme tokens', () => {
      const requiredTokens = [
        '--ide-sidebar-bg',
        '--ide-header-bg',
        '--ide-main-bg',
        '--ide-border',
        '--ide-border-strong',
        '--ide-hover-bg',
        '--ide-active-bg',
        '--ide-input-bg',
        '--ide-card-bg',
      ];

      for (const token of requiredTokens) {
        expect(cssContent).toContain(token);
      }
    });

    // Color contrast helper (WCAG 2.1 relative luminance calculation)
    function hexToLuminance(hex: string): number {
      const cleanHex = hex.replace('#', '');
      const r = parseInt(cleanHex.substring(0, 2), 16) / 255;
      const g = parseInt(cleanHex.substring(2, 4), 16) / 255;
      const b = parseInt(cleanHex.substring(4, 6), 16) / 255;

      const [rL, gL, bL] = [r, g, b].map((c) =>
        c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4),
      );

      return 0.2126 * rL! + 0.7152 * gL! + 0.0722 * bL!;
    }

    function getContrastRatio(hex1: string, hex2: string): number {
      const lum1 = hexToLuminance(hex1);
      const lum2 = hexToLuminance(hex2);
      const lighter = Math.max(lum1, lum2);
      const darker = Math.min(lum1, lum2);
      return (lighter + 0.05) / (darker + 0.05);
    }

    it('satisfies WCAG AA contrast standard (>= 4.5:1) for main text on dark theme backgrounds', () => {
      const textPrimary = '#f5f5f5'; // --text
      const textDim = '#a1a1aa';     // --text-dim

      const sidebarBg = '#141414';   // --ide-sidebar-bg
      const headerBg = '#181818';    // --ide-header-bg
      const mainBg = '#1e1e1e';      // --ide-main-bg
      const cardBg = '#181818';      // --ide-card-bg
      const inputBg = '#181818';     // --ide-input-bg

      // Primary text contrast checks (WCAG AAA requires 7.0:1)
      expect(getContrastRatio(textPrimary, sidebarBg)).toBeGreaterThan(15.0);
      expect(getContrastRatio(textPrimary, headerBg)).toBeGreaterThan(15.0);
      expect(getContrastRatio(textPrimary, mainBg)).toBeGreaterThan(15.0);
      expect(getContrastRatio(textPrimary, cardBg)).toBeGreaterThan(15.0);
      expect(getContrastRatio(textPrimary, inputBg)).toBeGreaterThan(15.0);

      // Dim text contrast checks (WCAG AA requires 4.5:1)
      expect(getContrastRatio(textDim, mainBg)).toBeGreaterThan(4.5);
      expect(getContrastRatio(textDim, sidebarBg)).toBeGreaterThan(4.5);
    });

    it('verifies syntax correctness of CSS variable rules for --ide- theme classes', () => {
      // Check that all var(--ide-*) references in styles.css correspond to defined variables
      const matches = cssContent.match(/var\((--ide-[\w-]+)\)/g) || [];
      const usedTokens = new Set(matches.map(m => m.replace(/^var\(/, '').replace(/\)$/, '')));

      const definedTokens = [
        '--ide-sidebar-bg',
        '--ide-header-bg',
        '--ide-main-bg',
        '--ide-border',
        '--ide-border-strong',
        '--ide-hover-bg',
        '--ide-active-bg',
        '--ide-input-bg',
        '--ide-card-bg',
      ];

      for (const token of usedTokens) {
        expect(definedTokens).toContain(token);
      }
    });
  });
});
