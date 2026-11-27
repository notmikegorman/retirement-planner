/**
 * THE BOOT TRACE (src/ui/bootTrace.ts) and the screens that read it — the
 * diagnosis for a blank page on a machine nobody else can touch.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bootTrace,
  resetBootTraceForTests,
  traceFinished,
  traceStep,
} from '../../src/ui/bootTrace';

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

describe('the trace', () => {
  beforeEach(() => resetBootTraceForTests());

  it('records each step in order and logs it with its elapsed time', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    traceStep('opening the storage');
    traceStep('taking the writer lock');
    expect(bootTrace().steps.map((s) => s.label)).toEqual([
      'opening the storage',
      'taking the writer lock',
    ]);
    expect(info.mock.calls[0][0]).toMatch(/^\[fplan boot\] opening the storage \(\+\d+ms\)$/);
    info.mockRestore();
  });

  it('stops recording once a screen is up', () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    traceFinished('the app');
    traceStep('later app work');
    expect(bootTrace().finished).toBe(true);
    expect(bootTrace().steps.map((s) => s.label)).toEqual(['showing the app']);
  });
});

describe('every wait before the first screen is named (source scan)', () => {
  it('traces the storage gate and the backend boot', () => {
    const gate = read('../../src/ui/local/storageChoice.ts');
    expect(gate).toContain("traceStep('loading the saved folder handle (IndexedDB)')");
    const backend = read('../../src/ui/local/localBackend.ts');
    for (const label of [
      "traceStep('opening the storage')",
      'traceStep(`taking the writer lock for ${storage.label}`)',
      "traceStep('reading the data folder’s files')",
    ]) {
      expect(backend).toContain(label);
    }
  });

  it('never leaves an IndexedDB open able to block silently', () => {
    expect(read('../../src/ui/local/storageChoice.ts')).toContain('req.onblocked = () =>');
  });

  it('marks every screen boot can end on as finished', () => {
    const main = read('../../src/ui/main.tsx');
    for (const screen of [
      "traceFinished('the storage chooser')",
      "traceFinished('the folder reconnect')",
      "traceFinished('the household setup')",
      "traceFinished('the app')",
      'traceFinished(`the boot failure: ${message}`)',
    ]) {
      expect(main).toContain(screen);
    }
    expect(main).toContain('render(<BootStatus />);');
  });

  it('has a no-bundle fallback in index.html for code that never starts', () => {
    const html = read('../../index.html');
    expect(html).toContain('if (window.__fplanBooting) return;');
    expect(read('../../src/ui/main.tsx')).toContain('__fplanBooting = true');
  });
});

describe('traceResume — a second boot is traced too', () => {
  it('switches the trace back on after a first screen', async () => {
    const { resetBootTraceForTests, traceFinished, traceResume, traceStep, bootTrace } = await import(
      '../../src/ui/bootTrace'
    );
    resetBootTraceForTests();
    traceStep('first');
    traceFinished('the storage chooser');
    traceStep('ignored');
    expect(bootTrace().finished).toBe(true);
    traceResume('starting again after the first screen');
    traceStep('opening the storage');
    expect(bootTrace().finished).toBe(false);
    expect(bootTrace().steps.map((s) => s.label)).toEqual([
      'first',
      'showing the storage chooser',
      'starting again after the first screen',
      'opening the storage',
    ]);
  });
});
