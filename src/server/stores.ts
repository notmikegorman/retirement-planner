/**
 * The node wiring of the store layer: THE data folder and THE bundled
 * defaults, composed once.
 *
 * This module is deliberately tiny — it is the only place under src/server
 * that decides WHICH folders the environment-neutral stores (src/store/*)
 * operate on. Everything environment-specific that used to live inside
 * dataStore.ts is here and nowhere else:
 *
 *   - the data folder: getDataDir() (FPLAN_DATA_DIR or ~/finance-planner-data),
 *     resolved per operation so the server tests can repoint it per test;
 *   - the defaults: <repoRoot>/data-defaults, resolved relative to THIS
 *     source file rather than process.cwd(), so the server works no matter
 *     where it is launched from.
 *
 * The sibling modules (dataStore.ts, planStore.ts, ...) re-export this one
 * instance's methods under their historical names, so every existing importer
 * — routes, scorers, managers, the golden harness, 300+ tests — keeps its
 * import path and its behaviour.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStores, type Stores } from '../store';
import { createNodeFileStore, dataFiles, type FileStore } from './fileStore';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const defaultsDir = path.join(repoRoot, 'data-defaults');

/**
 * The bundled defaults, read through the SAME FileStore contract as the data
 * folder (a second instance rooted elsewhere, used read-only). That is not
 * symmetry for its own sake: in the browser the defaults ship as bundled
 * assets, so seeding must already speak an interface a non-fs source can
 * implement — copy = readBytes here, writeBytes there.
 */
export const defaultsFiles: FileStore = createNodeFileStore(() => defaultsDir);

/** The one composed store set every server module delegates to. */
export const stores: Stores = createStores({ files: dataFiles, defaults: defaultsFiles });
