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
 *     prevent); wrongly true, it would nag a Chromium user who chose OPFS
 *     knowingly.
 */
import { describe, expect, it } from 'vitest';
import { parseStorageChoice, resolveBootGate } from '../../src/ui/local/storageChoice';
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

  it('a remembered OPFS choice boots straight in — no re-asking', () => {
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

describe('isSwapArtifact', () => {
  it('matches Chromium write-staging debris and nothing else', () => {
    expect(isSwapArtifact('plan.json.crswap')).toBe(true);
    expect(isSwapArtifact('.crswap')).toBe(true);
    expect(isSwapArtifact('plan.json')).toBe(false);
    expect(isSwapArtifact('crswap')).toBe(false);
    expect(isSwapArtifact('notes.crswap.json')).toBe(false);
  });
});
