/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import { configDefaults } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  /**
   * The served-from prefix (Phase 7). GitHub Pages serves a PROJECT site
   * under /<repo>/, so the Pages workflow builds with
   * FPLAN_BASE=/retirement-planner/ — every asset URL, worker chunk URL and
   * the router's path vocabulary (nav.ts reads import.meta.env.BASE_URL)
   * shift under it. Everything else — npm run dev, npm start, the parked
   * legacy server, the non-walkthrough browser lanes — keeps serving at /,
   * which is why this is env-driven rather than hardcoded.
   */
  base: process.env.FPLAN_BASE ?? '/',
  plugins: [react()],
  build: {
    outDir: 'dist/ui',
    chunkSizeWarningLimit: 1500,
  },
  server: {
    port: 5174,
    proxy: {
      '/api': 'http://localhost:5599',
    },
  },
  test: {
    environment: 'node',
    // Pins the test process's data-folder fallback to a throwaway directory
    // so late/leaked IO can never land in the user's real data folder.
    setupFiles: ['tests/vitest.setup.ts'],
    include: ['tests/**/*.test.ts'],
    // The browser lane (Playwright + Chromium, vitest.browser.config.ts) is
    // excluded so `npm test` stays the seconds-fast loop: those tests build a
    // bundle and launch a browser, and belong behind `npm run test:browser`.
    exclude: [...configDefaults.exclude, 'tests/browser/**'],
    testTimeout: 60000,
  },
});
