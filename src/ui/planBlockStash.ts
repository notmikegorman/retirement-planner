/**
 * THE PLAN-BLOCK STASH — a small, reusable pattern for toggles that DELETE
 * their block from the plan (2026-08-29).
 *
 * THE INCIDENT THAT EARNED IT: the Housing tab's "Turn off" removes
 * `plan.housing` — correctly, because the engine's contract is that absent
 * means unmodeled, and that contract is untouchable — and "Model the move
 * here" then seeded a fresh form. The owner refilled it from memory and
 * missed a real insurance quote that had been entered; absent, the engine's
 * price-based estimate stood in at roughly double, and the plan silently lost a point of
 * probability to a number he had already typed once. The engine was right
 * both times. The UI threw away his work.
 *
 * THE PATTERN: when a toggle removes a block, the UI stashes the removed
 * value in localStorage, KEYED PER DATA FOLDER, and rehydrates from the
 * stash when the toggle comes back on — with a provenance line saying
 * exactly where the values came from and when, because a silently restored
 * number is as suspect as a silently invented one. The plan on disk is
 * untouched either way: absent still means unmodeled, and the stash is
 * UI-side memory of what the owner once typed, never an input the engine
 * sees until the owner turns the block back on and runs.
 *
 * WHY PER FOLDER: localStorage is per browser origin, but the data is per
 * folder — two plans in two folders (File > New / File > Open) must not
 * inherit each other's stashed housing. The key is the same identity the
 * writer guard already mints and scopes its Web Lock by: the picked
 * folder's SavedFolder.id, OPFS's fixed folder id, or — in the parked HTTP
 * mode — the server's dataDir path. One identity per folder, minted once,
 * reused everywhere a per-folder shelf is needed.
 *
 * WIRED ONLY FOR HOUSING today, by the owner's scoping. The SEPP, insurance
 * and tithe toggles are candidates for the same treatment — see DECISIONS.md
 * ("The housing toggle keeps its configuration").
 */
import { backendMode, api } from './api';
import {
  OPFS_FOLDER_ID,
  loadFolderHandle,
  readStorageChoice,
} from './local/storageChoice';

/** What the shelf holds: the removed block, and when it was removed. */
export interface StashedBlock<T> {
  value: T;
  /** ISO — when the toggle removed the block; the provenance line quotes it. */
  stashedAt: string;
}

/** `fplan-stash:<folderKey>:<block>` — one shelf per block per folder. */
export function stashKey(folderKey: string, block: string): string {
  return `fplan-stash:${folderKey}:${block}`;
}

/**
 * Garbage-tolerant parse: anything that is not a `{ value, stashedAt }`
 * envelope reads as "no stash", never as a throw — a mangled shelf must cost
 * the fallback path, not the page.
 */
export function parseStash<T>(raw: string | null): StashedBlock<T> | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const o = parsed as Record<string, unknown>;
  if (typeof o.stashedAt !== 'string' || !('value' in o) || o.value === undefined) return null;
  return { value: o.value as T, stashedAt: o.stashedAt };
}

/** The storage seam, injectable so the rules are node-testable. */
type StringStore = Pick<Storage, 'getItem' | 'setItem'>;

function defaultStore(): StringStore | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null; // storage disabled: no shelf, the fallback path carries it
  }
}

export function readBlockStash<T>(
  folderKey: string,
  block: string,
  store: StringStore | null = defaultStore(),
): StashedBlock<T> | null {
  try {
    return parseStash<T>(store?.getItem(stashKey(folderKey, block)) ?? null);
  } catch {
    return null;
  }
}

export function writeBlockStash<T>(
  folderKey: string,
  block: string,
  value: T,
  now: Date,
  store: StringStore | null = defaultStore(),
): void {
  const envelope: StashedBlock<T> = { value, stashedAt: now.toISOString() };
  try {
    store?.setItem(stashKey(folderKey, block), JSON.stringify(envelope));
  } catch {
    // Storage disabled or full: the fallback (plan history) still stands.
  }
}

/**
 * The identity rule, pure (tests/ui/planBlockStash.test.ts): which fact
 * names this session's folder. Local + picked folder → the guard's minted
 * SavedFolder.id; local + OPFS → the fixed OPFS folder id; HTTP → the
 * server's dataDir path. Null when the fact is missing — the gate not yet
 * answered, the handle gone — and null degrades honestly: nothing stashes
 * and nothing rehydrates from a stash, leaving only the sources that live
 * IN the folder.
 */
export function resolveStashFolderKey(facts: {
  mode: 'http' | 'local';
  choice: 'opfs' | 'folder' | null;
  /** SavedFolder.id when the choice is 'folder' and the handle loaded. */
  folderId: string | null;
  /** meta().dataDir in HTTP mode. */
  dataDir: string | null;
}): string | null {
  if (facts.mode === 'http') return facts.dataDir;
  if (facts.choice === 'opfs') return OPFS_FOLDER_ID;
  if (facts.choice === 'folder') return facts.folderId;
  return null;
}

/** Gather the facts and apply the rule. Browser-side wrapper. */
export async function stashFolderKey(): Promise<string | null> {
  try {
    if (backendMode === 'http') {
      return resolveStashFolderKey({
        mode: 'http',
        choice: null,
        folderId: null,
        dataDir: (await api.meta()).dataDir,
      });
    }
    const choice = readStorageChoice();
    return resolveStashFolderKey({
      mode: 'local',
      choice,
      folderId: choice === 'folder' ? ((await loadFolderHandle())?.id ?? null) : null,
      dataDir: null,
    });
  } catch {
    return null;
  }
}
