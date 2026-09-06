/**
 * THE PORTABLE BACKUP: the whole data folder as ONE JSON file, out and back.
 *
 * WHY IT EXISTS. Safari and Firefox ship no folder picker, so on those
 * browsers the app runs in browser-private demo storage (D8): perfectly
 * usable, but the bytes live inside the browser profile where no ordinary
 * backup ever sees them and Clear browsing data erases them. Without a way
 * to get data OUT, that mode is a toy. This module is the way out — and,
 * symmetrically, the way back in on any machine or browser.
 *
 * WHY ONE JSON FILE AND NOT A ZIP. Every file in a data folder is text:
 * JSON records, the assumptions tables, one CSV of historical returns, a
 * README in scenarios/. Nothing is binary (nothing calls writeBytes outside
 * the seeding copy, which copies text too). So an envelope of
 * {path: contents} round-trips the folder EXACTLY with no encoding step, no
 * archive dependency, and — the property that matters for a project whose
 * pitch is "files you can read" — an export you can open in a text editor
 * and diff. A zip would buy compression the data does not need and cost a
 * dependency the app does not otherwise have.
 *
 * WHAT IS IN IT, AND WHAT IS DELIBERATELY NOT. Every record and every
 * assumptions/scenarios file; nothing from runs/ or searches/, which are
 * content-keyed caches that cost recomputation and nothing else (D7's
 * bargain) and would dwarf the records they travel with. Dot-files are
 * skipped too: they are app plumbing (.crswap staging debris,
 * .last-browser-open), never records.
 *
 * RESTORE WRITES, IT NEVER DELETES. Every path in the envelope is written,
 * replacing what is there; a file in the folder that the envelope does not
 * mention is left alone. That makes restore non-destructive on the way in —
 * the failure mode of a mistaken restore is "some old scenario files
 * survived", not "the folder I meant to keep is gone" — and it still makes a
 * round trip of the same file exact, because every record file is in every
 * envelope.
 */
import { parentDirOf, type FileStore } from '../shared/fileStore';

export const BACKUP_KIND = 'retirement-planner-backup';
export const BACKUP_VERSION = 1;

/**
 * Top-level directories a backup skips: content-keyed caches, deletable by
 * design, unbounded by design. Named here rather than at the call site so
 * the collector and its tests cannot disagree about the list.
 */
export const BACKUP_SKIPPED_DIRS: readonly string[] = ['runs', 'searches'];

export interface BackupEnvelope {
  kind: typeof BACKUP_KIND;
  version: number;
  /** ISO, for the human reading the file — nothing branches on it. */
  savedAt: string;
  /** Relative path → the file's exact text. Key order is sorted. */
  files: Record<string, string>;
}

/** Plumbing, not records: staging debris and boot bookkeeping. */
function isPlumbing(name: string): boolean {
  return name.startsWith('.') || name.endsWith('.crswap');
}

/**
 * Walk the folder into a flat path→text map. Recursive, skipping the cache
 * directories at the ROOT only: a `runs` directory nested inside scenarios/
 * would be somebody's data and is not ours to drop.
 */
async function collectDir(
  files: FileStore,
  relDir: string,
  out: Record<string, string>,
): Promise<void> {
  const entries = await files.list(relDir);
  for (const entry of entries) {
    if (isPlumbing(entry.name)) continue;
    const rel = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
    if (entry.kind === 'directory') {
      if (relDir === '' && BACKUP_SKIPPED_DIRS.includes(entry.name)) continue;
      await collectDir(files, rel, out);
    } else {
      out[rel] = await files.readText(rel);
    }
  }
}

export async function collectBackup(
  files: FileStore,
  now: () => Date = () => new Date(),
): Promise<BackupEnvelope> {
  const collected: Record<string, string> = {};
  await collectDir(files, '', collected);
  // Sorted keys so two backups of one unchanged folder are byte-identical —
  // which is what makes a diff of two exports mean something.
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(collected).sort()) sorted[key] = collected[key]!;
  return {
    kind: BACKUP_KIND,
    version: BACKUP_VERSION,
    savedAt: now().toISOString(),
    files: sorted,
  };
}

/** The name the download carries: dated, sorts chronologically, no spaces. */
export function backupFilename(now: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  return `retirement-planner-${stamp}.json`;
}

/**
 * Parse and VALIDATE an uploaded file. Every rejection says what the file
 * looked like instead, because the person restoring has no other way to tell
 * a truncated download from the wrong file entirely.
 */
export function parseBackup(raw: string): BackupEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      'That file is not JSON, so it is not a planner backup. Pick the ' +
        '.json file the Save button downloaded.',
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('That file is JSON, but not a planner backup (expected an object).');
  }
  const o = parsed as Record<string, unknown>;
  if (o.kind !== BACKUP_KIND) {
    throw new Error(
      `That file is not a planner backup: expected "kind": "${BACKUP_KIND}", found ` +
        `${o.kind === undefined ? 'no kind field' : JSON.stringify(o.kind)}.`,
    );
  }
  if (typeof o.version !== 'number' || o.version > BACKUP_VERSION) {
    throw new Error(
      `That backup was written by a newer version of the app (format ` +
        `${JSON.stringify(o.version)}; this app reads ${BACKUP_VERSION}). Update the page and try again.`,
    );
  }
  const filesField = o.files;
  if (typeof filesField !== 'object' || filesField === null || Array.isArray(filesField)) {
    throw new Error('That backup has no files in it — its "files" field is missing or not an object.');
  }
  const files: Record<string, string> = {};
  for (const [path, contents] of Object.entries(filesField as Record<string, unknown>)) {
    if (typeof contents !== 'string') {
      throw new Error(`That backup is damaged: the entry for ${path} is not text.`);
    }
    if (path.length === 0 || path.startsWith('/') || path.split('/').includes('..')) {
      throw new Error(`That backup contains an unsafe path (${path}) and was not restored.`);
    }
    files[path] = contents;
  }
  if (Object.keys(files).length === 0) {
    throw new Error('That backup is empty — there is nothing in it to restore.');
  }
  return { kind: BACKUP_KIND, version: o.version, savedAt: String(o.savedAt ?? ''), files };
}

/**
 * Write every file in the envelope, creating parent directories as needed.
 * Returns the paths written, in the order written, so the UI can say how
 * much arrived rather than a bare "done".
 */
export async function restoreBackup(
  files: FileStore,
  envelope: BackupEnvelope,
): Promise<string[]> {
  const written: string[] = [];
  for (const path of Object.keys(envelope.files).sort()) {
    const parent = parentDirOf(path);
    if (parent !== '') await files.mkdir(parent);
    await files.writeText(path, envelope.files[path]!);
    written.push(path);
  }
  return written;
}
