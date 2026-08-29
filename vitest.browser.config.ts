/**
 * The BROWSER LANE: `npm run test:browser` — Playwright driving real headless
 * Chromium against the Vite-built harness (tests/browser/).
 *
 * A separate config, not more include patterns, because the two lanes have
 * opposite performance contracts: `npm test` is the fast loop (thousands of
 * node-env tests in seconds) and must never sit behind a Vite build plus a
 * browser launch; this lane builds, serves and launches on purpose. The main
 * config excludes tests/browser/** for the same reason this one includes only
 * it — a file can be in exactly one lane.
 *
 * One-time setup on a fresh clone: `npx playwright install chromium`
 * (documented in DEVELOPMENT.md's Checks section).
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/browser/**/*.test.ts'],
    // One worker, one file: the lane holds a real browser and an HTTP server;
    // parallel copies would fight over nothing useful and blur any failure.
    fileParallelism: false,
    // The 10,000-path case runs the full engine twice (Node + Chromium), and
    // beforeAll pays for a Vite build and a browser launch.
    testTimeout: 300000,
    hookTimeout: 300000,
  },
});
