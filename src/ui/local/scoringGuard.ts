/**
 * THE KILLED-TAB GUARD FOR SCORING — the browser-port descendant of
 * update.sh's wait-for-quiet, and the sibling of the search guard in
 * searchClient.ts (same arm/disarm discipline, same incantation).
 *
 * In local mode the tab is the process: a close mid-scoring kills the
 * simulation. Since Phase 6 that no longer risks a silent permanent blank —
 * the write-ahead intent (store/scoringIntent.ts) makes the interruption
 * recoverable or honestly-labelled — but a warning is still cheaper than a
 * recovery: the browser cannot refuse a close, only pause it, and the pause
 * is armed EXACTLY while any scoring run is in flight and removed the moment
 * the registries drain. A guard that outlives the work it protects is a cry
 * of wolf; one that arms late is a hole.
 *
 * Wired through createServices' onScoringInFlightChange, which reports the
 * SUM of both scorers' registries — so a snapshot forming while a version
 * scores keeps the guard armed until the LAST run lands.
 */

let armed = false;

function warnOnUnload(ev: BeforeUnloadEvent): void {
  // The standard incantation: preventDefault flags the dialog, returnValue
  // keeps older Chromium honouring it. The browser shows its own generic
  // wording; the point is the pause, not the prose.
  ev.preventDefault();
  ev.returnValue = '';
}

/** The services hook: total scoring runs in flight, on every change. */
export function setScoringInFlight(inFlight: number): void {
  const shouldArm = inFlight > 0;
  if (shouldArm === armed) return;
  armed = shouldArm;
  if (shouldArm) addEventListener('beforeunload', warnOnUnload);
  else removeEventListener('beforeunload', warnOnUnload);
}
