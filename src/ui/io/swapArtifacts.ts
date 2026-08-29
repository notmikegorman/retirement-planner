/**
 * ORPHANED SWAP FILES (`*.crswap`), decided for Phase 7: ignore in listings,
 * sweep at boot.
 *
 * Chromium's createWritable() stages every write in a sibling swap file —
 * `plan.json` is written as `plan.json.crswap` and atomically renamed at
 * close(). That staging is what makes the browser driver's writes atomic
 * (fsaFileStore.ts), and its failure mode is the good one: a tab killed
 * mid-write leaves the OLD file intact plus an orphaned `.crswap`. The
 * orphan is pure debris — Chromium never resumes or reads one — but in a
 * PICKED real folder it is debris the owner can see, git can track, and a
 * directory listing would hand to store code that expects only records.
 *
 * Two defenses, both here so the policy has one home:
 *
 *   - isSwapArtifact() — the name test fsaFileStore.list() filters with, so
 *     no store ever enumerates a swap file as if it were data. Filtering at
 *     the driver (not per-store) matches where the artifact comes from: the
 *     driver's own write mechanism.
 *   - sweepSwapArtifacts() — the boot-time sweep localBackend runs AFTER the
 *     writer guard is held and BEFORE any store reads the folder. Holding
 *     the guard is what makes deletion safe: no other writer of this folder
 *     can be mid-write (same profile: excluded by the Web Lock; foreign
 *     writer: the lease refusal fired first), so any `.crswap` present is by
 *     definition an orphan from a dead session, not a write in flight.
 *
 * The sweep also covers the folder's git story: without it, a killed tab
 * would leave a file the owner's data-folder repo shows as untracked noise
 * forever (README's backup advice tells them to `.gitignore` it too, as the
 * belt to this suspender).
 */

/** True for Chromium's write-staging debris (`<name>.crswap`). */
export function isSwapArtifact(name: string): boolean {
  return name.endsWith('.crswap');
}

/**
 * Recursively remove every `*.crswap` under `dir`. Returns the relative
 * paths removed, so the caller can log what was cleaned (a sweep that works
 * silently would hide the very interruptions it exists to tidy up after).
 * Individual failures are skipped, not fatal: a swap file that cannot be
 * removed is exactly as harmless as it was before the sweep, and boot must
 * not die over debris.
 */
export async function sweepSwapArtifacts(
  dir: FileSystemDirectoryHandle,
  prefix = '',
): Promise<string[]> {
  const removed: string[] = [];
  const entries: { name: string; kind: 'file' | 'directory' }[] = [];
  for await (const entry of dir.values()) {
    entries.push({ name: entry.name, kind: entry.kind });
  }
  for (const entry of entries) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.kind === 'directory') {
      try {
        const child = await dir.getDirectoryHandle(entry.name);
        removed.push(...(await sweepSwapArtifacts(child, rel)));
      } catch {
        // The directory vanished or refused: nothing to sweep there.
      }
    } else if (isSwapArtifact(entry.name)) {
      try {
        await dir.removeEntry(entry.name);
        removed.push(rel);
      } catch {
        // Could not remove: leave it; it is inert either way.
      }
    }
  }
  return removed;
}
