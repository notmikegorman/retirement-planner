/**
 * The topbar's FOLDER CONTROL (File > New / File > Open, 2026-08-29): the
 * pure label/menu rules (folderControlLogic.ts), the remembered-folder list
 * rules (storageChoice.ts), and the wiring scans that hold the switch to its
 * safety order — refuse while work is in flight, permission behind the click
 * gesture, graceful guard release, THEN the reload.
 *
 * The owner's ask, and the property the control must keep: "File > New and
 * then, when done, File > Open to go back to my plan" — a round trip that
 * never loses the way home. The remembered list is the way home.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DEMO_FOLDER_NOTE,
  NEW_FOLDER_HINT,
  SERVER_FOLDER_NOTE,
  SWITCH_BUSY_NOTE,
  folderControlLabel,
  folderMenuKind,
  serverFolderName,
} from '../../src/ui/components/topbar/folderControlLogic';
import {
  sortRememberedFolders,
  upsertRememberedFolder,
  type RememberedFolder,
} from '../../src/ui/local/storageChoice';

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const control = read('../../src/ui/components/topbar/FolderControl.tsx');
const app = read('../../src/ui/App.tsx');
const writerGuard = read('../../src/ui/io/browserWriterGuard.ts');

// ---------------------------------------------------------------------------

describe('the control always names the CURRENT storage', () => {
  it('a picked folder shows by its own name', () => {
    expect(
      folderControlLabel({
        mode: 'local',
        choice: 'folder',
        canPickFolder: true,
        folderName: 'Retirement Planner',
      }),
    ).toBe('Retirement Planner');
  });

  it('OPFS keeps the two names the app already uses — one storage, one name each', () => {
    // A pre-cut 'opfs' choice on a picker browser is "Browser-private
    // storage"; the pickerless fallback is "Demo storage", matching the D8
    // banner it renders under.
    expect(
      folderControlLabel({ mode: 'local', choice: 'opfs', canPickFolder: true, folderName: null }),
    ).toBe('Browser-private storage');
    expect(
      folderControlLabel({ mode: 'local', choice: 'opfs', canPickFolder: false, folderName: null }),
    ).toBe('Demo storage');
  });

  it('HTTP mode shows the server data folder by its last path segment', () => {
    expect(folderControlLabel({ mode: 'http', dataDir: '/Users/mike/finance-planner-data' })).toBe(
      'finance-planner-data',
    );
    expect(serverFolderName('/a/b/data/')).toBe('data');
    expect(serverFolderName('C:\\planner\\data')).toBe('data');
    // While meta has not answered, the label is honestly pending, not a guess.
    expect(folderControlLabel({ mode: 'http', dataDir: null })).toBe('…');
  });

  it('a folder whose name is unknowable still gets honest words', () => {
    expect(
      folderControlLabel({ mode: 'local', choice: 'folder', canPickFolder: true, folderName: null }),
    ).toBe('your data folder');
  });
});

describe('which menu opens', () => {
  it('a picker browser gets the switcher — even when the current storage is OPFS', () => {
    expect(
      folderMenuKind({ mode: 'local', choice: 'folder', canPickFolder: true, folderName: 'x' }),
    ).toBe('switcher');
    expect(
      folderMenuKind({ mode: 'local', choice: 'opfs', canPickFolder: true, folderName: null }),
    ).toBe('switcher');
  });

  it('the pickerless demo gets the explanation, not a dead switcher', () => {
    expect(
      folderMenuKind({ mode: 'local', choice: 'opfs', canPickFolder: false, folderName: null }),
    ).toBe('demo-note');
    expect(DEMO_FOLDER_NOTE).toContain('there is no folder connection to switch');
  });

  it('HTTP mode explains that switching is a browser-mode feature', () => {
    expect(folderMenuKind({ mode: 'http', dataDir: '/x/data' })).toBe('server-note');
    expect(SERVER_FOLDER_NOTE).toContain('the server owns its data folder');
    expect(SERVER_FOLDER_NOTE).toContain('browser-mode feature');
  });

  it('New is not a mode: the hint says why one picker serves both doors', () => {
    // An empty pick flows into the zero-start setup exactly as a first boot
    // would; a non-empty pick under "New" just opens. Same rule as boot.
    expect(NEW_FOLDER_HINT).toContain('Pick an empty folder to start from zero');
    expect(NEW_FOLDER_HINT).toContain('already holds planner data just opens it');
  });
});

describe('the remembered-folders list rules', () => {
  const fakeHandle = {} as FileSystemDirectoryHandle;
  const f = (id: string, lastOpened: string): RememberedFolder => ({
    id,
    handle: fakeHandle,
    lastOpened,
  });

  it('orders most recently opened first', () => {
    const sorted = sortRememberedFolders([
      f('a', '2026-08-01T00:00:00.000Z'),
      f('b', '2026-08-29T00:00:00.000Z'),
      f('c', '2026-08-15T00:00:00.000Z'),
    ]);
    expect(sorted.map((x) => x.id)).toEqual(['b', 'c', 'a']);
  });

  it('upserts by id — one entry per folder, ever', () => {
    const list = [f('a', '2026-08-01T00:00:00.000Z'), f('b', '2026-08-02T00:00:00.000Z')];
    const next = upsertRememberedFolder(list, f('a', '2026-08-29T00:00:00.000Z'));
    expect(next.map((x) => x.id)).toEqual(['a', 'b']);
    expect(next[0].lastOpened).toBe('2026-08-29T00:00:00.000Z');
    // A new folder simply joins, at its opened position.
    expect(
      upsertRememberedFolder(list, f('c', '2026-08-03T00:00:00.000Z')).map((x) => x.id),
    ).toEqual(['c', 'b', 'a']);
  });
});

describe('the switch keeps the guard discipline (source scans)', () => {
  it('sits in the sidebar footer, below the Settings item', () => {
    expect(app).toContain('<FolderControl />');
    const footer = app.slice(app.indexOf('className="sideNavFooter"'));
    expect(footer.indexOf("navigate('settings')")).toBeLessThan(
      footer.indexOf('<FolderControl />'),
    );
  });

  it('refuses to switch while scoring or a search is in flight', () => {
    // Switching releases the writer guard and reloads. A run in flight would
    // arm beforeunload, whose dialog can cancel the reload — leaving a live,
    // WRITING tab holding no guard. The refusal closes that hole before it
    // opens, on every switch path.
    expect(control).toContain('localWorkInFlight');
    expect(control).toContain('scoringInFlight()');
    expect(control).toContain('searchesInFlight()');
    expect(control).toContain('if (await refuseIfBusy()) return;');
    expect(SWITCH_BUSY_NOTE).toContain('before switching');
    // Both switch paths run the check — the listed folder and the picker.
    expect(control.match(/if \(await refuseIfBusy\(\)\) return;/g)!.length).toBe(2);
  });

  it('re-requests folder permission INSIDE the click gesture, then lets the gate own refusals', () => {
    expect(control).toContain("requestPermission?.({ mode: 'readwrite' })");
  });

  it('releases the guard gracefully before the reload, in that order', () => {
    const fn = control.slice(control.indexOf('async function releaseGuardAndReload'));
    const body = fn.slice(0, fn.indexOf('}\n\n'));
    // The CALL must exist (an index of -1 would order "before" anything and
    // let a switch that skips the release pass vacuously), and it must come
    // before the reload — release-then-reload is the whole handoff.
    const releaseAt = body.indexOf('await releaseHeldGuard();');
    const reloadAt = body.indexOf('location.reload()');
    expect(releaseAt).toBeGreaterThan(-1);
    expect(reloadAt).toBeGreaterThan(-1);
    expect(releaseAt).toBeLessThan(reloadAt);
    // And the guard documents why the ordinary path has no release at all:
    // the tab dying IS the release, and releasing on pagehide would drop the
    // lock while a bfcache'd page could still come back.
    expect(writerGuard).toContain('the tab dying IS the');
    expect(writerGuard).toContain('bfcache');
  });

  it('loads the local machinery lazily — the HTTP bundle stays pure', () => {
    // The same discipline as api.ts's lazy backend: FolderControl renders in
    // every mode, so its static imports must not drag the local chunk in.
    expect(control).toContain("import('../../io/browserWriterGuard')");
    expect(control).toContain("import('../../local/scoringGuard')");
    expect(control).toContain("import('../../local/searchClient')");
    expect(control).not.toMatch(/^import .*from '\.\.\/\.\.\/io\/browserWriterGuard'/m);
    expect(control).not.toMatch(/^import .*from '\.\.\/\.\.\/local\/scoringGuard'/m);
    expect(control).not.toMatch(/^import .*from '\.\.\/\.\.\/local\/searchClient'/m);
  });

  it('a denied permission never costs the remembered list — the way home survives refusal', () => {
    // The permission re-request may be refused; the component PROCEEDS (the
    // boot gate's reconnect page owns that state) and nothing on the refusal
    // path clears the list. And the storage layer's open path re-writes the
    // WHOLE list with the opened entry upserted — never a truncation to the
    // one entry being opened, which would wipe every other way home.
    const storage = read('../../src/ui/local/storageChoice.ts');
    const openFn = storage.slice(storage.indexOf('export async function openRememberedFolder'));
    expect(openFn).toContain('upsertRememberedFolder(list,');
    const saveFn = storage.slice(storage.indexOf('export async function saveFolderHandle'));
    expect(saveFn).toContain('upsertRememberedFolder(list,');
    // The refusal is caught and swallowed — proceeding, not wiping.
    const denial = control.slice(control.indexOf('await folder.handle.requestPermission'));
    expect(denial.slice(0, 300)).toContain('catch {');
    expect(control).not.toContain('setFolders([])');
  });

  it('every pick funnels through saveFolderHandle — the one door that maintains the list', () => {
    expect(control).toContain('saveFolderHandle(handle)');
    expect(control).toContain("writeStorageChoice('folder')");
    // Closing the picker is an answer, not an error — same rule as the boot
    // chooser's.
    expect(control).toContain("err.name === 'AbortError'");
  });
});
