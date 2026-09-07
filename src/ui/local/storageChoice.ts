/**
 * WHERE THE DATA LIVES — the Phase-7 boot question, and everything that
 * remembers its answer.
 *
 * Shipped, the first local-mode visit must ask one question before anything
 * touches storage. On a picker-capable browser the question has ONE visible
 * answer — a real folder on disk (the same plain-JSON folder the Node server
 * always kept, reached through showDirectoryPicker); on Safari/Firefox the
 * only door is browser-private OPFS demo storage (D8). The OPFS card the
 * chooser used to offer beside the folder was cut on 2026-08-29 after the
 * owner's first real test-drive (DECISIONS.md, "The chooser loses its second
 * answer") — the OFFER went away, the storage did not: a remembered 'opfs'
 * choice from before the cut still boots, and the browser test lanes keep
 * booting OPFS through the seam below. This module owns:
 *
 *   - the remembered CHOICE ('opfs' | 'folder'), in localStorage — the same
 *     shelf as the backend-mode memory, because both answer "how does this
 *     origin boot" and both must survive a reload;
 *   - the picked folder HANDLE, in IndexedDB — the one thing localStorage
 *     cannot hold (handles are structured-clone-only). The handle is a
 *     pointer, not data: losing it (Clear browsing data) costs one re-pick
 *     and nothing else, exactly the R7 posture from the port plan;
 *   - the pure gate rule (resolveBootGate) main.tsx renders from — pure so
 *     the whole first-visit / returning / permission-lapsed / no-picker
 *     matrix is node-testable without a browser;
 *   - resolveStorageForBoot(), the impure end localBackend calls once the
 *     gate says ready: hand me the handle, its Web-Lock scope id, and how
 *     error messages should name it.
 *
 * WHY THE GATE IS SEPARATE FROM THE BACKEND BOOT: permission re-grants and
 * the picker itself demand a user gesture, so the flow must be able to stop
 * and render a button. localBackend (behind api.ts's lazy import) has no
 * renderer; main.tsx has no storage knowledge. This module is the seam
 * between them.
 */
import { randomHex } from '../../shared/random';

export type StorageChoice = 'opfs' | 'folder';

/**
 * The remembered choice's localStorage key — and, deliberately, THE SEAM the
 * browser test lanes boot OPFS through. Headless Chromium ships
 * showDirectoryPicker (so the chooser shows only the folder action) but can
 * never complete the native dialog, so every lane pre-seeds
 * `localStorage['fplan-storage'] = 'opfs'` before boot — the Phase-7
 * returning-user mechanism, and byte-identical to what the retired chooser
 * button used to write, which is also why a real user who chose
 * browser-private storage before the 2026-08-29 cut still boots. Test-only
 * in spirit on picker-capable browsers: since the cut, no visible UI on such
 * a browser writes 'opfs' (pinned by the pages-walkthrough lane); only D8's
 * no-picker fallback button still does.
 */
export const STORAGE_CHOICE_KEY = 'fplan-storage';

/** The OPFS directory the browser-private mode keeps the data folder in. */
export const OPFS_FOLDER = 'fplan-data';

/** OPFS Web-Lock scope: one folder, one writer, per browser profile. */
export const OPFS_FOLDER_ID = `opfs:${OPFS_FOLDER}`;

// ---------------------------------------------------------------------------
// Show a friend mode
// ---------------------------------------------------------------------------

/**
 * SHOW A FRIEND MODE: a second, entirely separate OPFS folder holding the
 * fictional example household, which the app boots on INSTEAD of the real
 * storage while the mode is on.
 *
 * WHY A WHOLE SEPARATE FOLDER rather than masking numbers on screen. The
 * point of the mode is that a friend looking over your shoulder sees no real
 * figure of yours — and a display-layer mask has to be right at every single
 * site that renders a number: cards, tables, tooltips, chart axes and
 * labels, the CSV in Save a copy. One missed site is the whole feature
 * failing at the only moment it matters. Booting a different folder has no
 * such surface: the real data is never read, so nothing downstream can leak
 * it, and every figure on screen — including the simulations, which run on
 * the sample household — is consistently made up.
 *
 * WHY IT DOES NOT TOUCH THE REMEMBERED CHOICE. Turning the mode on must not
 * cost you the folder you picked: STORAGE_CHOICE_KEY and the saved handle
 * are left exactly as they are, and this flag simply OVERRIDES them for as
 * long as it is set. Turning the mode off restores the real folder with no
 * re-picking and no permission prompt.
 *
 * EDITS MADE IN THE MODE ARE KEPT — in the friend folder, where they belong.
 * A demo you have already walked through once should still be where you left
 * it; none of it can reach the real data, which is the only guarantee that
 * matters here.
 */
export const FRIEND_MODE_KEY = 'fplan-friend-mode';

/**
 * ON BY DEFAULT (the owner's call, 2026-09-07). The flag is stored as the
 * explicit string 'off' to leave it; anything else — including a browser
 * that has never heard of this app — reads as ON.
 *
 * WHAT THAT BUYS: the failure this feature exists to prevent is a real
 * figure reaching a screen someone else is looking at, and every way that
 * happens starts with the mode being OFF when the owner believed it was on.
 * Defaulting to on inverts the risk: the worst a wrong default can now do is
 * show the owner an invented household until he turns it off, which is
 * obvious within a second and costs one click.
 *
 * WHAT IT CHANGES FOR A FIRST VISIT: the app opens on the sample household
 * rather than the storage chooser, for everyone. That is not a detour around
 * the boot question so much as a better order for it — the visitor sees the
 * app actually working before being asked where their data should live, and
 * turning the mode off is what asks. A browser that has never chosen storage
 * lands on the chooser the moment the mode goes off, which is the right
 * moment for it.
 */
const FRIEND_MODE_OFF = 'off';

/** The OPFS directory the sample household lives in — never the real one. */
export const FRIEND_OPFS_FOLDER = 'fplan-friend';

/** Its own Web-Lock scope: a different folder is a different writer. */
export const FRIEND_OPFS_FOLDER_ID = `opfs:${FRIEND_OPFS_FOLDER}`;

/**
 * Is the mode on? Only the explicit string 'off' turns it off, so an absent
 * or unreadable value reads as ON — the direction that cannot leak. (The
 * corner that costs: a browser where localStorage throws outright can never
 * record the 'off', so it stays in the mode. Rare, and it fails towards
 * privacy rather than away from it.)
 */
export function readFriendMode(): boolean {
  try {
    return localStorage.getItem(FRIEND_MODE_KEY) !== FRIEND_MODE_OFF;
  } catch {
    return true;
  }
}

/**
 * Throw the sample away and let the next boot seed a fresh one.
 *
 * WHY IT EXISTS AT ALL: the friend folder is disposable by definition —
 * everything in it is invented, and a demo walked through a few times
 * accumulates edits nobody wants to keep. It earned its place the hard way,
 * though. While the plan-block stash was keyed by the CHOSEN folder rather
 * than the BOOTED one (fixed 2026-09-07), clicking "Model the move here"
 * inside the mode wrote the owner's REAL housing move into the sample
 * household's plan — which promptly bankrupted an invented household that
 * cannot afford a real house, reporting 0.0%. Fixing the leak stops new
 * ones; it cannot clean a folder already polluted. This does.
 *
 * It touches ONLY the friend folder. The real storage is not named here.
 */
export async function resetFriendFolder(): Promise<void> {
  const opfs = await navigator.storage.getDirectory();
  try {
    await opfs.removeEntry(FRIEND_OPFS_FOLDER, { recursive: true });
  } catch {
    // Already gone (or never created): the next boot seeds it either way,
    // which is exactly the outcome asked for.
  }
}

/**
 * Turn the mode on or off. Both states are written EXPLICITLY — removing the
 * key would mean "on", which is the opposite of what turning it off means.
 * The caller reloads; boot re-reads this.
 */
export function writeFriendMode(on: boolean): void {
  try {
    localStorage.setItem(FRIEND_MODE_KEY, on ? 'on' : FRIEND_MODE_OFF);
  } catch {
    /* storage disabled: the toggle cannot persist, and boot reads the default */
  }
}

// ---------------------------------------------------------------------------
// The remembered choice (localStorage)
// ---------------------------------------------------------------------------

/** Garbage-tolerant: anything but the two known values reads as "not chosen". */
export function parseStorageChoice(raw: string | null): StorageChoice | null {
  return raw === 'opfs' || raw === 'folder' ? raw : null;
}

export function readStorageChoice(): StorageChoice | null {
  try {
    return parseStorageChoice(localStorage.getItem(STORAGE_CHOICE_KEY));
  } catch {
    return null; // storage disabled: every visit asks — annoying, never wrong
  }
}

export function writeStorageChoice(choice: StorageChoice): void {
  try {
    localStorage.setItem(STORAGE_CHOICE_KEY, choice);
  } catch {
    // Storage disabled: the choice holds for this load only.
  }
}

export function clearStorageChoice(): void {
  try {
    localStorage.removeItem(STORAGE_CHOICE_KEY);
  } catch {
    // Nothing to clear if nothing could be stored.
  }
}

// ---------------------------------------------------------------------------
// Capability + persistence
// ---------------------------------------------------------------------------

/** Chromium ships the directory picker; Safari/Firefox do not (risk R6). */
export function supportsFolderPicker(): boolean {
  return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
}

/**
 * Ask the browser to shield this origin's storage from eviction — the OPFS
 * bytes and the stored folder handle both live under it. Called once, when
 * storage is chosen; the answer is surfaced QUIETLY (a console line and a
 * Settings-page row) because it changes durability at the margin, not the
 * design: records in a picked folder are real files eviction cannot touch,
 * and OPFS mode's honest label already says the browser owns its fate.
 */
export async function requestStoragePersistence(): Promise<boolean | null> {
  try {
    if (typeof navigator === 'undefined' || navigator.storage?.persist === undefined) return null;
    return await navigator.storage.persist();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The folder handle (IndexedDB — the only shelf that can hold one)
// ---------------------------------------------------------------------------

const DB_NAME = 'fplan';
const DB_STORE = 'handles';
const HANDLE_KEY = 'data-folder';
/**
 * The REMEMBERED-FOLDERS list (File > Open, 2026-08-29) — every folder this
 * browser profile was ever granted, beside the current-folder pointer above.
 * Same store, second key: no DB version bump, so a pre-list profile opens
 * unchanged and its lone remembered handle is adopted into the list on first
 * read (see listRememberedFolders).
 */
const FOLDER_LIST_KEY = 'data-folders';

export interface SavedFolder {
  /**
   * Minted once per FOLDER (not per pick, since the list landed): stored
   * beside the handle, used as the Web-Lock scope AND as the per-folder
   * localStorage identity (ui/planBlockStash.ts). Every tab of this profile
   * loads the same record, so every tab contends on the same lock — and
   * re-picking a folder the list already knows re-adopts its id via
   * isSameEntry, so two tabs that reached one folder through different picks
   * still contend on one lock. (A path would be nicer; the API deliberately
   * never reveals one.)
   */
  id: string;
  handle: FileSystemDirectoryHandle;
}

/** A list entry: the saved folder plus when it was last the current one. */
export interface RememberedFolder extends SavedFolder {
  /** ISO — orders the File menu, most recently opened first. */
  lastOpened: string;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(DB_STORE)) {
        req.result.createObjectStore(DB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB refused to open'));
  });
}

function requestDone<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

// ---- pure list rules (node-tested in tests/ui/storageGate.test.ts) --------

/** Most recently opened first; a tie keeps input order (stable sort). */
export function sortRememberedFolders(list: readonly RememberedFolder[]): RememberedFolder[] {
  return [...list].sort((a, b) => b.lastOpened.localeCompare(a.lastOpened));
}

/** The list with `record` upserted by id — one entry per folder, ever. */
export function upsertRememberedFolder(
  list: readonly RememberedFolder[],
  record: RememberedFolder,
): RememberedFolder[] {
  return sortRememberedFolders([...list.filter((f) => f.id !== record.id), record]);
}

/** Garbage-tolerant read of whatever the list key holds. */
function parseFolderList(raw: unknown): RememberedFolder[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (f): f is RememberedFolder =>
      typeof f === 'object' &&
      f !== null &&
      typeof (f as RememberedFolder).id === 'string' &&
      typeof (f as RememberedFolder).lastOpened === 'string' &&
      Boolean((f as RememberedFolder).handle),
  );
}

// ---- the shelves ----------------------------------------------------------

/**
 * One pass against the handles store; the db opens and closes here.
 *
 * THE BODY MAY ONLY AWAIT IDB REQUESTS. An IndexedDB transaction auto-commits
 * the moment the event loop turns with no request pending, so awaiting
 * anything else inside (isSameEntry, a timer) deactivates the transaction and
 * the next put throws. Callers that need a non-IDB await (saveFolderHandle's
 * identity check) split into two passes around it instead.
 */
async function withStore<T>(
  mode: IDBTransactionMode,
  body: (store: IDBObjectStore) => Promise<T>,
): Promise<T> {
  const db = await openDb();
  try {
    return await body(db.transaction(DB_STORE, mode).objectStore(DB_STORE));
  } finally {
    db.close();
  }
}

/**
 * The id a fresh pick should carry: the LIST's id when the picked handle is a
 * folder the profile already knows (isSameEntry — the API's only identity
 * test), a newly minted one otherwise. Re-using the id is what keeps the
 * Web-Lock scope and the per-folder stash stable across re-picks of one
 * folder.
 */
async function idForHandle(
  handle: FileSystemDirectoryHandle,
  list: readonly RememberedFolder[],
): Promise<string> {
  for (const known of list) {
    try {
      if (await handle.isSameEntry(known.handle)) return known.id;
    } catch {
      // A dead stored handle cannot be compared; it simply never matches.
    }
  }
  return `folder-${randomHex(8)}`;
}

/**
 * Remember a picked folder as THE folder: writes the current-folder pointer
 * and upserts the remembered list (File > Open's menu). Every pick path —
 * the boot chooser and the topbar control — comes through here. Two IDB
 * passes around the identity check, because isSameEntry is a non-IDB await
 * (see withStore's contract).
 */
export async function saveFolderHandle(handle: FileSystemDirectoryHandle): Promise<SavedFolder> {
  const known = await withStore('readonly', async (store) =>
    parseFolderList(await requestDone(store.get(FOLDER_LIST_KEY))),
  );
  const record: SavedFolder = { id: await idForHandle(handle, known), handle };
  return withStore('readwrite', async (store) => {
    const list = parseFolderList(await requestDone(store.get(FOLDER_LIST_KEY)));
    await requestDone(store.put(record, HANDLE_KEY));
    await requestDone(
      store.put(
        upsertRememberedFolder(list, { ...record, lastOpened: new Date().toISOString() }),
        FOLDER_LIST_KEY,
      ),
    );
    return record;
  });
}

/**
 * Every folder this profile was ever granted, most recently opened first.
 * A profile from before the list existed holds only the pointer; its lone
 * folder is adopted into the list here (dated at the epoch — it sorts last
 * until it is opened again, which is the honest reading of "never opened
 * since the list has existed").
 */
export async function listRememberedFolders(): Promise<RememberedFolder[]> {
  try {
    return await withStore('readwrite', async (store) => {
      const list = parseFolderList(await requestDone(store.get(FOLDER_LIST_KEY)));
      if (list.length > 0) return sortRememberedFolders(list);
      const legacy = await requestDone<SavedFolder | undefined>(store.get(HANDLE_KEY));
      if (!legacy || typeof legacy.id !== 'string' || !legacy.handle) return [];
      const adopted = [{ ...legacy, lastOpened: new Date(0).toISOString() }];
      await requestDone(store.put(adopted, FOLDER_LIST_KEY));
      return adopted;
    });
  } catch {
    return []; // an unreadable shelf and an empty one land the same place
  }
}

/**
 * Make a remembered folder the current one (File > Open on a listed entry):
 * pointer written, lastOpened bumped. Null when the id is not in the list —
 * the caller falls back to asking for a fresh pick.
 */
export async function openRememberedFolder(id: string): Promise<SavedFolder | null> {
  try {
    return await withStore('readwrite', async (store) => {
      const list = parseFolderList(await requestDone(store.get(FOLDER_LIST_KEY)));
      const found = list.find((f) => f.id === id);
      if (found === undefined) return null;
      const record: SavedFolder = { id: found.id, handle: found.handle };
      await requestDone(store.put(record, HANDLE_KEY));
      await requestDone(
        store.put(
          upsertRememberedFolder(list, { ...found, lastOpened: new Date().toISOString() }),
          FOLDER_LIST_KEY,
        ),
      );
      return record;
    });
  } catch {
    return null;
  }
}

export async function loadFolderHandle(): Promise<SavedFolder | null> {
  try {
    const db = await openDb();
    try {
      const record = await requestDone<SavedFolder | undefined>(
        db.transaction(DB_STORE, 'readonly').objectStore(DB_STORE).get(HANDLE_KEY),
      );
      return record && typeof record.id === 'string' && record.handle ? record : null;
    } finally {
      db.close();
    }
  } catch {
    return null; // an unreadable shelf and an empty one land the same place
  }
}

export async function forgetFolderHandle(): Promise<void> {
  try {
    const db = await openDb();
    try {
      await requestDone(db.transaction(DB_STORE, 'readwrite').objectStore(DB_STORE).delete(HANDLE_KEY));
    } finally {
      db.close();
    }
  } catch {
    // Nothing stored, or IndexedDB unavailable: forgotten either way.
  }
}

// ---------------------------------------------------------------------------
// The gate rule (pure — tests/ui/storageGate.test.ts)
// ---------------------------------------------------------------------------

export type BootGateState =
  /** First visit, or the folder connection is gone: ask THE question. */
  | { kind: 'choose'; canPickFolder: boolean }
  /** Folder chosen, handle present, but the browser wants a click first. */
  | { kind: 'reconnect'; folderName: string }
  /** Boot straight onto OPFS. `demo` marks the no-picker fallback (D8). */
  | { kind: 'ready-opfs'; demo: boolean }
  /** Show a friend mode: boot the sample household's own OPFS folder. */
  | { kind: 'ready-friend' }
  /** Boot onto the picked folder; permission already granted. */
  | { kind: 'ready-folder' };

/**
 * The whole boot-gate rule in one pure function. The matrix it resolves:
 *
 *   choice null            → choose (the first-visit question)
 *   choice opfs            → ready; demo iff this browser has no picker,
 *                            because then OPFS was never a choice — it was
 *                            the only door, and the app must keep saying so.
 *                            On a picker browser a remembered 'opfs' predates
 *                            the 2026-08-29 chooser cut or came through the
 *                            lane seam (STORAGE_CHOICE_KEY) — either way it
 *                            boots, un-nagged: the cut removed the offer,
 *                            never the storage
 *   choice folder, handle gone (site data cleared)     → choose again
 *   choice folder, permission granted                  → ready
 *   choice folder, permission prompt/denied            → reconnect: the
 *     re-grant needs a user gesture, so the gate stops and renders a button
 *     ('denied' lands here too — requestPermission may still prompt, and if
 *     the browser holds the refusal the reconnect page says what to do)
 */
export function resolveBootGate(facts: {
  choice: StorageChoice | null;
  canPickFolder: boolean;
  handleFound: boolean;
  folderName: string | null;
  permission: PermissionState | null;
  friendMode?: boolean;
}): BootGateState {
  // FIRST, ahead of every other row: the mode overrides the remembered
  // choice, so it must never stop at the chooser or a folder reconnect. Its
  // storage is OPFS, always present, never needing permission — which is
  // also what makes turning it on safe from any state, including one whose
  // real folder currently needs a re-grant.
  if (facts.friendMode === true) return { kind: 'ready-friend' };
  if (facts.choice === 'folder') {
    if (!facts.handleFound) return { kind: 'choose', canPickFolder: facts.canPickFolder };
    if (facts.permission === 'granted' || facts.permission === null) {
      return { kind: 'ready-folder' };
    }
    return { kind: 'reconnect', folderName: facts.folderName ?? 'your data folder' };
  }
  if (facts.choice === 'opfs') return { kind: 'ready-opfs', demo: !facts.canPickFolder };
  return { kind: 'choose', canPickFolder: facts.canPickFolder };
}

/**
 * THE GATE'S SECOND STAGE (zero-start, 2026-08-29): between storage-ready and
 * app-ready. It can only be asked AFTER the backend boots — "does the folder
 * hold a profile" is a fact about the folder, and the folder is only readable
 * once the writer guard holds it — so it is a separate pure rule rather than
 * a fifth BootGateState member, applied by main.tsx right after
 * ensureBackendReady():
 *
 *   demo (D8's no-picker fallback)  → never setup: the demo's whole purpose
 *                                     is a filled example, and its boot seeds
 *                                     the starter household exactly as before;
 *   profile present                 → the app (a populated folder — picked or
 *                                     OPFS — is untouched and just opens);
 *   profile absent                  → the SETUP step: collect the few facts
 *                                     the engine cannot run without, write
 *                                     one minimal profile through the normal
 *                                     store path, and only then render the
 *                                     app. Nothing is written until submit,
 *                                     so abandoning setup and reloading lands
 *                                     back on setup.
 */
export function profileSetupNeeded(facts: {
  demo: boolean;
  profileExists: boolean;
  friendMode?: boolean;
}): boolean {
  // Show a friend mode reads exactly like the demo here, and for the same
  // reason: its whole purpose is a filled example household, so it must
  // never stop to ask a stranger's birth year.
  if (facts.demo || facts.friendMode === true) return false;
  return !facts.profileExists;
}

/** The only facts that matter once the mode is on — the rule ignores the rest. */
const FRIEND_GATE_FACTS = {
  choice: null,
  canPickFolder: false,
  handleFound: false,
  folderName: null,
  permission: null,
  friendMode: true,
} as const;

/** Gather the facts and apply the rule. Browser-side wrapper for main.tsx. */
export async function computeBootGate(): Promise<BootGateState> {
  // FIRST, before the choice is even read, and for the same reason
  // resolveStorageForBoot checks it first: the mode overrides the choice, so
  // no other row of the matrix can apply and the real folder's handle must
  // not be loaded to decide. (Checking it further down cost a bug: the
  // no-folder early return below had its own resolveBootGate call, so a
  // brand-new visit — the exact case the ON-by-default is for — went
  // straight to the chooser.)
  const friendMode = readFriendMode();
  if (friendMode) return resolveBootGate(FRIEND_GATE_FACTS);
  const choice = readStorageChoice();
  const canPickFolder = supportsFolderPicker();
  if (choice !== 'folder') {
    return resolveBootGate({ choice, canPickFolder, handleFound: false, folderName: null, permission: null });
  }
  const saved = await loadFolderHandle();
  // A missing queryPermission (never the case on the one engine that ships
  // pickers, but declared optional) reads as granted: the handle either
  // works or the boot's own first read fails loudly.
  const permission =
    saved === null ? null : ((await saved.handle.queryPermission?.({ mode: 'readwrite' })) ?? null);
  return resolveBootGate({
    choice,
    canPickFolder,
    handleFound: saved !== null,
    folderName: saved?.handle.name ?? null,
    permission,
    friendMode,
  });
}

// ---------------------------------------------------------------------------
// What localBackend boots on
// ---------------------------------------------------------------------------

export interface ResolvedStorage {
  kind: StorageChoice | 'friend';
  handle: FileSystemDirectoryHandle;
  /** Web-Lock scope: same folder ⇒ same id ⇒ same single-writer contention. */
  folderId: string;
  /** How meta.dataDir and driver error messages name this storage. */
  label: string;
}

/**
 * The storage the gate approved, handed to localBackend. Throws (with a
 * sentence, not a code) when called before the gate has run or after the
 * world moved under it — main.tsx renders the message with a Retry, and the
 * retry re-runs the gate.
 */
export async function resolveStorageForBoot(): Promise<ResolvedStorage> {
  // The override, before the remembered choice is even read: while the mode
  // is on there is exactly one answer, and the real folder is not opened at
  // all — not read, not locked, not listed.
  if (readFriendMode()) {
    const opfs = await navigator.storage.getDirectory();
    const handle = await opfs.getDirectoryHandle(FRIEND_OPFS_FOLDER, { create: true });
    return {
      kind: 'friend',
      handle,
      folderId: FRIEND_OPFS_FOLDER_ID,
      label: '(sample data — Show a friend mode)',
    };
  }
  const choice = readStorageChoice();
  if (choice === 'folder') {
    const saved = await loadFolderHandle();
    if (saved === null) {
      throw new Error(
        'The saved data-folder connection is gone (usually: site data was cleared). ' +
          'Reload the page to choose where your data lives — the folder itself is untouched.',
      );
    }
    const permission = (await saved.handle.queryPermission?.({ mode: 'readwrite' })) ?? 'granted';
    if (permission !== 'granted') {
      throw new Error(
        `The browser has not granted access to the folder "${saved.handle.name}" yet. ` +
          'Reload the page and click Reconnect.',
      );
    }
    return {
      kind: 'folder',
      handle: saved.handle,
      folderId: saved.id,
      label: `folder "${saved.handle.name}"`,
    };
  }
  if (choice === 'opfs') {
    const opfs = await navigator.storage.getDirectory();
    const handle = await opfs.getDirectoryHandle(OPFS_FOLDER, { create: true });
    return {
      kind: 'opfs',
      handle,
      folderId: OPFS_FOLDER_ID,
      label: '(browser-private storage)',
    };
  }
  throw new Error(
    'No storage has been chosen yet — reload the page and answer where your data should live.',
  );
}
