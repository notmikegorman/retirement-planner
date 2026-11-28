/**
 * The Phase-7 boot gate's pure rule (src/ui/local/storageChoice.ts) and the
 * swap-artifact policy (src/ui/io/swapArtifacts.ts) — every branch of the
 * first-visit / returning / permission-lapsed / no-picker matrix pinned in
 * node, because each wrong answer has a concrete cost:
 *
 *   - 'choose' shown to a returning user would read as data loss;
 *   - 'ready' granted to an unconnected folder would boot onto nothing and
 *     fail 27 methods deep instead of one page early;
 *   - a missed 'reconnect' would call requestPermission outside a user
 *     gesture, which the browser silently rejects — a boot that hangs;
 *   - the demo flag wrongly false would let a Safari session believe its
 *     edits are durable records (the exact lie D8's banner exists to
 *     prevent); wrongly true, it would nag a Chromium user whose OPFS is a
 *     knowing pre-cut choice (or a lane's seeded one) — see the stranded-
 *     user case below;
 *   - and since the 2026-08-29 chooser cut ("The chooser loses its second
 *     answer", DECISIONS.md), a remembered 'opfs' answered 'choose' would
 *     STRAND every user who picked browser-private storage while it was
 *     offered — the cut removed the offer, never the storage.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  NO_ANSWER,
  latestPermissionQuery,
  loadFolderHandle,
  saveFolderHandle,
  queryFolderPermission,
  parseStorageChoice,
  profileSetupNeeded,
  resolveBootGate,
} from '../../src/ui/local/storageChoice';
import { isSwapArtifact } from '../../src/ui/io/swapArtifacts';

/** Shorthand: facts with first-visit defaults, overridden per case. */
function gate(overrides: Partial<Parameters<typeof resolveBootGate>[0]>) {
  return resolveBootGate({
    choice: null,
    canPickFolder: true,
    handleFound: false,
    folderName: null,
    permission: null,
    ...overrides,
  });
}

describe('parseStorageChoice', () => {
  it('accepts exactly the two known values', () => {
    expect(parseStorageChoice('opfs')).toBe('opfs');
    expect(parseStorageChoice('folder')).toBe('folder');
  });

  it('reads garbage and absence as "not chosen", never guessed at', () => {
    expect(parseStorageChoice(null)).toBeNull();
    expect(parseStorageChoice('')).toBeNull();
    expect(parseStorageChoice('OPFS')).toBeNull();
    expect(parseStorageChoice('idb')).toBeNull();
  });
});

describe('resolveBootGate', () => {
  it('first visit: THE question, with the picker option where it exists', () => {
    expect(gate({})).toEqual({ kind: 'choose', canPickFolder: true });
    expect(gate({ canPickFolder: false })).toEqual({ kind: 'choose', canPickFolder: false });
  });

  it('a remembered OPFS choice boots straight in — the chooser cut must never strand one', () => {
    // Nobody can make this choice through visible UI on a picker browser any
    // more (the walkthrough lane pins that), but everyone who made it before
    // the 2026-08-29 cut still carries 'opfs' in localStorage — and the
    // browser lanes seed the same value through the STORAGE_CHOICE_KEY seam.
    // Both must land here: ready, no re-asking, no demo nag.
    expect(gate({ choice: 'opfs' })).toEqual({ kind: 'ready-opfs', demo: false });
  });

  it('OPFS on a pickerless browser is DEMO — the D8 banner must keep saying so', () => {
    expect(gate({ choice: 'opfs', canPickFolder: false })).toEqual({
      kind: 'ready-opfs',
      demo: true,
    });
  });

  it('folder chosen + handle present + permission granted boots straight in', () => {
    expect(
      gate({ choice: 'folder', handleFound: true, folderName: 'plans', permission: 'granted' }),
    ).toEqual({ kind: 'ready-folder' });
  });

  it('folder chosen but the browser wants a gesture: reconnect, named', () => {
    expect(
      gate({ choice: 'folder', handleFound: true, folderName: 'plans', permission: 'prompt' }),
    ).toEqual({ kind: 'reconnect', folderName: 'plans' });
    // 'denied' lands on reconnect too — requestPermission may still prompt,
    // and the page says what to do if the browser holds the refusal.
    expect(
      gate({ choice: 'folder', handleFound: true, folderName: 'plans', permission: 'denied' }),
    ).toEqual({ kind: 'reconnect', folderName: 'plans' });
  });

  it('a folder handle that reports no permission API reads as connected', () => {
    expect(gate({ choice: 'folder', handleFound: true, folderName: 'plans' })).toEqual({
      kind: 'ready-folder',
    });
  });

  it('folder chosen but the handle is gone (cleared site data): choose again', () => {
    expect(gate({ choice: 'folder', handleFound: false })).toEqual({
      kind: 'choose',
      canPickFolder: true,
    });
  });

  it('a nameless handle still reconnects, with the generic name', () => {
    expect(gate({ choice: 'folder', handleFound: true, permission: 'prompt' })).toEqual({
      kind: 'reconnect',
      folderName: 'your data folder',
    });
  });
});

describe('profileSetupNeeded (the gate’s second stage — zero-start)', () => {
  it('an empty non-demo folder gets the setup step, never an invented household', () => {
    // Both roads here matter: the picked real folder, and OPFS reached
    // through the lane seam (or a pre-cut choice) on a picker browser.
    expect(profileSetupNeeded({ demo: false, profileExists: false })).toBe(true);
  });

  it('a populated folder just opens — byte-for-byte the returning-user boot', () => {
    expect(profileSetupNeeded({ demo: false, profileExists: true })).toBe(false);
  });

  it('the D8 demo never lands on setup: its purpose is the filled example', () => {
    expect(profileSetupNeeded({ demo: true, profileExists: true })).toBe(false);
    // Belt and braces: even if the demo seed were somehow missing, the demo
    // path must not ask a Safari user to type a household into storage the
    // banner says is erasable — the demo seeds, it never asks.
    expect(profileSetupNeeded({ demo: true, profileExists: false })).toBe(false);
  });
});

describe('Show a friend mode (the storage override)', () => {
  it('overrides every other row of the matrix — chooser, reconnect and all', () => {
    // The whole point: turning it on must work from ANY state, including a
    // first visit that has never chosen storage and a folder whose
    // permission has lapsed. Its storage is OPFS, always present, needing no
    // grant, so there is nothing for the gate to stop and ask about.
    expect(gate({ friendMode: true })).toEqual({ kind: 'ready-friend' });
    expect(gate({ friendMode: true, choice: 'folder', handleFound: false })).toEqual({
      kind: 'ready-friend',
    });
    expect(
      gate({ friendMode: true, choice: 'folder', handleFound: true, permission: 'prompt' }),
    ).toEqual({ kind: 'ready-friend' });
    expect(gate({ friendMode: true, choice: 'opfs', canPickFolder: false })).toEqual({
      kind: 'ready-friend',
    });
  });

  it('off (or absent) changes nothing about the existing matrix', () => {
    expect(gate({ friendMode: false, choice: 'opfs' })).toEqual({ kind: 'ready-opfs', demo: false });
    expect(gate({ choice: 'opfs' })).toEqual({ kind: 'ready-opfs', demo: false });
    expect(gate({ friendMode: false })).toEqual({ kind: 'choose', canPickFolder: true });
  });

  it('never lands on the setup step — a filled example is the point', () => {
    expect(profileSetupNeeded({ demo: false, profileExists: false, friendMode: true })).toBe(false);
    expect(profileSetupNeeded({ demo: false, profileExists: true, friendMode: true })).toBe(false);
    // And the flag absent still means the ordinary rule.
    expect(profileSetupNeeded({ demo: false, profileExists: false })).toBe(true);
  });
});

describe('isSwapArtifact', () => {
  it('matches Chromium write-staging debris and nothing else', () => {
    expect(isSwapArtifact('plan.json.crswap')).toBe(true);
    expect(isSwapArtifact('.crswap')).toBe(true);
    expect(isSwapArtifact('plan.json')).toBe(false);
    expect(isSwapArtifact('crswap')).toBe(false);
    expect(isSwapArtifact('notes.crswap.json')).toBe(false);
  });
});

describe('queryFolderPermission — a browser that never answers does not hang the boot', () => {
  const asHandle = (h: object) => h as unknown as FileSystemDirectoryHandle;

  it('passes an answer through', async () => {
    const h = asHandle({ queryPermission: async () => 'granted' });
    expect(await queryFolderPermission(h, 50)).toBe('granted');
  });

  it('reads a missing queryPermission as null', async () => {
    expect(await queryFolderPermission(asHandle({}), 50)).toBeNull();
  });

  it('gives NO_ANSWER when the query never settles', async () => {
    const h = asHandle({ queryPermission: () => new Promise(() => {}) });
    expect(await queryFolderPermission(h, 20)).toBe(NO_ANSWER);
  });

  it('the boot gate and the boot both go through the bounded query', () => {
    const src = readFileSync(resolve(__dirname, '../../src/ui/local/storageChoice.ts'), 'utf8');
    const bare = src.split('\n').filter((l) => /await saved\.handle\.queryPermission/.test(l));
    expect(bare).toEqual([]);
    expect(src.match(/await queryFolderPermission\(saved\.handle\)/g)?.length).toBe(2);
  });
});

describe('a late permission answer is not lost', () => {
  it('exposes the query that outlived the cutoff', async () => {
    let answer!: (s: PermissionState) => void;
    const h = {
      queryPermission: () => new Promise<PermissionState>((r) => (answer = r)),
    } as unknown as FileSystemDirectoryHandle;
    expect(await queryFolderPermission(h, 10)).toBe(NO_ANSWER);
    const late = latestPermissionQuery();
    expect(late).not.toBeNull();
    answer('granted');
    expect(await late).toBe('granted');
  });

  it('the Reconnect screen boots on a late grant', () => {
    const src = readFileSync(resolve(__dirname, '../../src/ui/main.tsx'), 'utf8');
    expect(src).toMatch(/bootWhenLateGrantArrives\(\);\s*return;/);
    expect(src).toMatch(/state === 'granted' && bootGeneration === startedAt/);
  });
});

describe('saveFolderHandle — a write the browser throws away is an error, not a silent success', () => {
  /** A tiny IndexedDB stand-in whose readwrite transactions abort after their puts "succeed". */
  function fakeIdb(abortWrites: boolean) {
    const data = new Map<string, unknown>();
    const req = <T,>(result: T) => {
      const r: { result?: T; onsuccess?: () => void; onerror?: () => void } = {};
      setTimeout(() => {
        r.result = result;
        r.onsuccess?.();
      }, 0);
      return r;
    };
    const db = {
      objectStoreNames: { contains: () => true },
      close: () => undefined,
      transaction: (_s: string, mode: string) => {
        const pending = new Map<string, unknown>();
        const tx: Record<string, unknown> & {
          oncomplete?: () => void;
          onabort?: () => void;
          error: DOMException | null;
        } = { error: null };
        tx.objectStore = () => ({
          get: (k: string) => req(data.get(k)),
          put: (v: unknown, k: string) => {
            pending.set(k, v);
            return req(k);
          },
        });
        setTimeout(() => {
          if (mode === 'readwrite' && abortWrites) {
            tx.error = new DOMException('commit failed', 'AbortError');
            tx.onabort?.();
          } else {
            for (const [k, v] of pending) data.set(k, v);
            tx.oncomplete?.();
          }
        }, 5);
        return tx;
      },
    };
    return {
      data,
      open: () => {
        const r: Record<string, unknown> & { onsuccess?: () => void } = { result: db };
        setTimeout(() => r.onsuccess?.(), 0);
        return r;
      },
    };
  }

  it('a thrown-away commit is logged, and this visit still boots on the pick', async () => {
    vi.stubGlobal('indexedDB', fakeIdb(true));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const handle = { name: 'Data', isSameEntry: async () => false } as unknown as FileSystemDirectoryHandle;
    const saved = await saveFolderHandle(handle);
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/IndexedDB threw the write away \(AbortError: commit failed\)/);
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/was not kept/);
    expect((await loadFolderHandle())?.handle).toBe(saved.handle);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('resolves, and reads back, when the commit lands', async () => {
    const idb = fakeIdb(false);
    vi.stubGlobal('indexedDB', idb);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const handle = { name: 'Data', isSameEntry: async () => false } as unknown as FileSystemDirectoryHandle;
    const saved = await saveFolderHandle(handle);
    expect((await loadFolderHandle())?.id).toBe(saved.id);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
});
