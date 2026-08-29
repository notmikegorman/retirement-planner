/**
 * Builds the parity harness with Vite's JS API — the same bundler, worker
 * pipeline (`new Worker(new URL(...), { type: 'module' })`) and transforms the
 * real app build will use, because the bundler IS part of what the parity gate
 * tests: a transform that subtly changed engine arithmetic would only ever be
 * caught by running the BUILT output.
 */
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

export const HARNESS_DIR = fileURLToPath(new URL('./harness', import.meta.url));
export const HARNESS_OUT_DIR = fileURLToPath(
  // Under dist/ (gitignored): a build artifact, never a source.
  new URL('../../dist/parity-harness', import.meta.url),
);

export async function buildParityHarness(): Promise<void> {
  await build({
    configFile: false, // the app's vite.config.ts is for the UI; the harness is self-contained
    logLevel: 'warn',
    root: HARNESS_DIR,
    build: {
      outDir: HARNESS_OUT_DIR,
      emptyOutDir: true,
      // Unminified on purpose: parity failures are debugged by reading the
      // bundle, and minification changes no arithmetic worth testing.
      minify: false,
      target: 'es2022',
    },
    worker: {
      // ES-module worker chunks, matching the { type: 'module' } spawn.
      format: 'es',
    },
  });
}
