/**
 * THE PORTABLE BACKUP (src/store/portableBackup.ts): what travels, what
 * deliberately does not, and every way an uploaded file can be wrong.
 *
 * The load-bearing property is the ROUND TRIP: collect a folder, restore the
 * envelope into an empty one, and the two folders must hold the same bytes.
 * That is the whole promise the Settings card makes to a Safari user whose
 * data lives nowhere else, so it is tested over the real memory driver
 * rather than asserted about a mock.
 */
import { describe, expect, it } from 'vitest';
import { createMemoryFileStore, seedMemoryFileStore } from '../../src/shared/memoryFileStore';
import type { FileStore } from '../../src/shared/fileStore';
import {
  BACKUP_KIND,
  BACKUP_VERSION,
  backupFilename,
  collectBackup,
  parseBackup,
  restoreBackup,
} from '../../src/store/portableBackup';

const FOLDER: Record<string, string> = {
  'profile.json': '{\n  "people": []\n}\n',
  'plan.json': '{\n  "description": "the plan"\n}\n',
  'plan-history.json': '[]\n',
  'networth.json': '{\n  "snapshots": []\n}\n',
  'quotes.json': '{}\n',
  'assumptions/market.json': '{\n  "equityReal": 0.05\n}\n',
  'assumptions/historical-returns.csv': 'year,stocks\n1928,0.4381\n',
  'assumptions/tax/federal-2026.json': '{\n  "brackets": []\n}\n',
  'scenarios/base-case.json': '{\n  "name": "base"\n}\n',
  'scenarios/README.md': '# scenarios\n',
};

async function folderWith(extra: Record<string, string> = {}): Promise<FileStore> {
  const store = createMemoryFileStore();
  await seedMemoryFileStore(store, { ...FOLDER, ...extra });
  return store;
}

/** Every file in the store, flat, for a bytes-level comparison. */
async function treeOf(files: FileStore, relDir = ''): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await files.list(relDir)) {
    const rel = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
    if (entry.kind === 'directory') Object.assign(out, await treeOf(files, rel));
    else out[rel] = await files.readText(rel);
  }
  return out;
}

describe('collectBackup', () => {
  it('carries every record, assumption and scenario file', async () => {
    const envelope = await collectBackup(await folderWith());
    expect(envelope.kind).toBe(BACKUP_KIND);
    expect(envelope.version).toBe(BACKUP_VERSION);
    expect(Object.keys(envelope.files).sort()).toEqual(Object.keys(FOLDER).sort());
    expect(envelope.files['assumptions/historical-returns.csv']).toBe(
      FOLDER['assumptions/historical-returns.csv'],
    );
  });

  it('leaves the caches out — they cost recomputation, not records', async () => {
    const envelope = await collectBackup(
      await folderWith({
        'runs/abc123.json': '{"huge": true}\n',
        'searches/def456.json': '{"huge": true}\n',
      }),
    );
    expect(Object.keys(envelope.files)).not.toContain('runs/abc123.json');
    expect(Object.keys(envelope.files)).not.toContain('searches/def456.json');
  });

  it('leaves plumbing out — staging debris and boot bookkeeping are not data', async () => {
    const envelope = await collectBackup(
      await folderWith({
        '.last-browser-open': '2026-09-06\n',
        'plan.json.crswap': 'half a write\n',
      }),
    );
    expect(Object.keys(envelope.files)).not.toContain('.last-browser-open');
    expect(Object.keys(envelope.files)).not.toContain('plan.json.crswap');
  });

  it('sorts its keys, so two saves of one unchanged folder are byte-identical', async () => {
    const a = await collectBackup(await folderWith(), () => new Date('2026-09-06T10:00:00.000Z'));
    const b = await collectBackup(await folderWith(), () => new Date('2026-09-06T10:00:00.000Z'));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(Object.keys(a.files)).toEqual([...Object.keys(a.files)].sort());
  });

  it('records the save time from the injected clock', async () => {
    const envelope = await collectBackup(await folderWith(), () => new Date('2026-09-06T10:00:00.000Z'));
    expect(envelope.savedAt).toBe('2026-09-06T10:00:00.000Z');
  });
});

describe('the round trip', () => {
  it('restores a folder byte-for-byte into an empty one', async () => {
    const source = await folderWith({ 'runs/cached.json': '{"cache": true}\n' });
    const envelope = await collectBackup(source);

    const target = createMemoryFileStore();
    const written = await restoreBackup(target, envelope);

    expect(written.sort()).toEqual(Object.keys(FOLDER).sort());
    // The caches did not travel, so the target holds exactly the records.
    expect(await treeOf(target)).toEqual(FOLDER);
  });

  it('survives a JSON serialization in between — the file really is the transport', async () => {
    const envelope = await collectBackup(await folderWith());
    const onDisk = `${JSON.stringify(envelope, null, 2)}\n`;

    const target = createMemoryFileStore();
    await restoreBackup(target, parseBackup(onDisk));
    expect(await treeOf(target)).toEqual(FOLDER);
  });

  it('replaces what it names and leaves what it does not', async () => {
    const envelope = await collectBackup(await folderWith());
    const target = await folderWith({
      'plan.json': '{\n  "description": "STALE"\n}\n',
      'scenarios/mine.json': '{\n  "name": "keep me"\n}\n',
    });

    await restoreBackup(target, envelope);
    expect(await target.readText('plan.json')).toBe(FOLDER['plan.json']);
    // Not in the envelope, so not touched: a mistaken restore costs nothing
    // that was not already being replaced.
    expect(await target.readText('scenarios/mine.json')).toBe('{\n  "name": "keep me"\n}\n');
  });

  it('creates the directories it needs — restore into a bare folder works', async () => {
    const envelope = await collectBackup(await folderWith());
    const target = createMemoryFileStore();
    await restoreBackup(target, envelope);
    expect(await target.readText('assumptions/tax/federal-2026.json')).toBe(
      FOLDER['assumptions/tax/federal-2026.json'],
    );
  });
});

describe('parseBackup rejects, and says what it saw', () => {
  const rejects = (raw: string, fragment: string): void => {
    expect(() => parseBackup(raw)).toThrow(new RegExp(fragment, 'i'));
  };

  it('refuses a file that is not JSON at all', () => {
    rejects('not json {', 'not JSON');
  });

  it('refuses JSON that is not an object', () => {
    rejects('[1, 2, 3]', 'not a planner backup');
  });

  it('refuses an object without the backup kind, naming what it found', () => {
    rejects('{"kind": "something-else"}', 'something-else');
    rejects('{"files": {}}', 'no kind field');
  });

  it('refuses a backup from a newer format than this app reads', () => {
    rejects(
      JSON.stringify({ kind: BACKUP_KIND, version: BACKUP_VERSION + 1, files: { 'a.json': '{}' } }),
      'newer version',
    );
  });

  it('accepts an OLDER format version — reading back is the whole point', () => {
    const envelope = parseBackup(
      JSON.stringify({ kind: BACKUP_KIND, version: 0, savedAt: '', files: { 'plan.json': '{}' } }),
    );
    expect(envelope.files['plan.json']).toBe('{}');
  });

  it('refuses a damaged entry rather than writing a non-string', () => {
    rejects(
      JSON.stringify({ kind: BACKUP_KIND, version: 1, files: { 'plan.json': { not: 'text' } } }),
      'damaged',
    );
  });

  it('refuses an empty backup', () => {
    rejects(JSON.stringify({ kind: BACKUP_KIND, version: 1, files: {} }), 'empty');
  });

  it('refuses paths that would escape the data folder', () => {
    rejects(
      JSON.stringify({ kind: BACKUP_KIND, version: 1, files: { '../outside.json': '{}' } }),
      'unsafe path',
    );
    rejects(
      JSON.stringify({ kind: BACKUP_KIND, version: 1, files: { '/etc/passwd': 'x' } }),
      'unsafe path',
    );
  });
});

describe('backupFilename', () => {
  it('is dated, sorts chronologically, and carries no spaces', () => {
    const name = backupFilename(new Date(2026, 8, 6));
    expect(name).toBe('retirement-planner-2026-09-06.json');
    expect(name).not.toContain(' ');
  });
});
