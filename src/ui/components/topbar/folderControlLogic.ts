/**
 * Pure rules for the topbar's FOLDER CONTROL (File > New / File > Open,
 * 2026-08-29). No React, no IO — the label, the menu shape, and every
 * sentence the menu prints live here so the whole matrix is node-testable
 * (tests/ui/folderControl.test.ts).
 *
 * The owner's ask, verbatim: "I would like something like File > New and
 * File > Open. Specifically, so I can experience what a new user would
 * experience. I would do File > New and then, when done, I can do File >
 * Open to go back to my plan." So the control's whole job is: always show
 * WHERE the data on screen lives, and make leaving for another folder — or
 * an empty one — one click plus the picker.
 *
 * NEW IS NOT A MODE. "New folder…" runs the same picker and the same boot as
 * "Open another folder…"; the only difference is the hint beside it, because
 * the mechanism that makes an empty pick a fresh start ALREADY EXISTS — the
 * zero-start gate (storageChoice.profileSetupNeeded) renders the setup step
 * for any profile-less folder, exactly as a first boot would, and a non-empty
 * pick under "New" simply opens, setup appearing only when no profile exists.
 * Same rule as boot, one rule total.
 */
import type { StorageChoice } from '../../local/storageChoice';

/** What the control needs to know; gathered by the component, judged here. */
export type FolderControlFacts =
  /** The parked Node server: it owns its folder; dataDir from /api/meta. */
  | { mode: 'http'; dataDir: string | null }
  | {
      mode: 'local';
      choice: StorageChoice | null;
      canPickFolder: boolean;
      /** The picked folder's name, when the choice is 'folder'. */
      folderName: string | null;
    };

/**
 * The server folder's display name: the last path segment, because the full
 * path is the Settings page's data card's job and the sidebar has room for
 * a name. Both separators, since the parked server may run anywhere.
 */
export function serverFolderName(dataDir: string): string {
  const trimmed = dataDir.replace(/[/\\]+$/, '');
  const segments = trimmed.split(/[/\\]/);
  const last = segments[segments.length - 1];
  return last === '' ? trimmed : last;
}

/**
 * What the control always shows: the CURRENT folder's name. "Browser-private
 * storage" and "Demo storage" are the two OPFS readings the app already
 * distinguishes (the D8 demo banner's own line), kept verbatim so one
 * storage never has two names.
 */
export function folderControlLabel(facts: FolderControlFacts): string {
  if (facts.mode === 'http') {
    return facts.dataDir === null ? '…' : serverFolderName(facts.dataDir);
  }
  if (facts.choice === 'folder') return facts.folderName ?? 'your data folder';
  if (facts.choice === 'opfs') {
    return facts.canPickFolder ? 'Browser-private storage' : 'Demo storage';
  }
  // The gate answers before the app renders, so this is a transient frame.
  return '…';
}

/**
 * Which menu opens: the real switcher, or one of the two honest explanations.
 * A remembered pre-cut 'opfs' choice on a picker browser still gets the
 * switcher — that user can move to folders; only the pickerless demo cannot.
 */
export type FolderMenuKind = 'switcher' | 'demo-note' | 'server-note';

export function folderMenuKind(facts: FolderControlFacts): FolderMenuKind {
  if (facts.mode === 'http') return 'server-note';
  return facts.canPickFolder ? 'switcher' : 'demo-note';
}

// ---------------------------------------------------------------------------
// Every sentence the menu prints
// ---------------------------------------------------------------------------

/** HTTP mode: the server owns the folder; switching is a browser-mode feature. */
export const SERVER_FOLDER_NOTE =
  'This session talks to the local Node server, and the server owns its data folder — ' +
  'folder switching is a browser-mode feature. Open the deployed app (or add ' +
  '?backend=local) to open and switch folders from here.';

/** Safari/Firefox demo: no picker, so there is no folder to switch to. */
export const DEMO_FOLDER_NOTE =
  'Demo storage lives inside this browser profile — there is no folder connection to ' +
  'switch. The folder picker ships in Chrome, Edge, and Brave; open this page there for ' +
  'file-backed folders you can switch between.';

/** The hint under "New folder…" — why an empty pick is the fresh start. */
export const NEW_FOLDER_HINT =
  'Pick an empty folder to start from zero — the app asks the few facts it needs, exactly ' +
  'as a first boot would. Picking a folder that already holds planner data just opens it.';

/** Shown when the current storage is OPFS and the menu offers folders. */
export const OPFS_STAYS_NOTE =
  'Your current data lives in browser-private storage and stays there — opening a folder ' +
  'does not move it. Reopen browser-private storage from Switch storage on the Settings ' +
  'page.';

/**
 * The refusal while work is in flight. Switching releases the writer guard
 * and reloads; a run mid-flight would either be abandoned by the reload or —
 * worse, if its beforeunload dialog talked the user out of the reload — keep
 * writing into a folder this tab no longer guards. So the switch refuses
 * first, in words.
 */
export const SWITCH_BUSY_NOTE =
  'A simulation or search is still running in this folder. Let it finish — or stop it — ' +
  'before switching: switching now would abandon the run mid-flight.';
