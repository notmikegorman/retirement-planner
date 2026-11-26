/**
 * THE BOOT TRACE — what the app is waiting on before its first screen.
 *
 * Nothing renders until the boot has decided where the data lives and opened
 * it, and every step of that is an await on something outside the page:
 * IndexedDB, a folder permission, a Web Lock, a file read (which, for a folder
 * in iCloud Drive whose files macOS has offloaded, waits for the download).
 * One of those never settling is a BLANK PAGE WITH NOTHING IN THE CONSOLE —
 * the owner's report from a second laptop, 2026-11-26. So each step is named
 * here as it starts: logged to the console with its elapsed time, and kept for
 * the on-screen status main.tsx shows when the boot runs long.
 */

export interface BootStep {
  label: string;
  /** ms since navigation start. */
  at: number;
}

const steps: BootStep[] = [];
let finished = false;

function now(): number {
  return typeof performance !== 'undefined' ? Math.round(performance.now()) : 0;
}

/** Record that the boot has started waiting on `label`. */
export function traceStep(label: string): void {
  if (finished) return;
  const step = { label, at: now() };
  steps.push(step);
  console.info(`[fplan boot] ${label} (+${step.at}ms)`);
}

/** The boot reached a screen; later steps are ordinary app work, not boot. */
export function traceFinished(screen: string): void {
  if (finished) return;
  traceStep(`showing ${screen}`);
  finished = true;
}

export function bootTrace(): { steps: readonly BootStep[]; finished: boolean } {
  return { steps, finished };
}

/** Tests only. */
export function resetBootTraceForTests(): void {
  steps.length = 0;
  finished = false;
}
