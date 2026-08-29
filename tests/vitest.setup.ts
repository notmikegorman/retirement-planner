/**
 * A FLOOR UNDER EVERY TEST: inside the test process, the data-folder fallback
 * is a throwaway directory — never the user's real folder.
 *
 * Every store resolves its root per operation through getDataDir(), which
 * falls back to ~/finance-planner-data whenever FPLAN_DATA_DIR is unset. The
 * test files all point FPLAN_DATA_DIR at per-test temp dirs and restore the
 * previous value in afterEach — which is right, except that "the previous
 * value" at process start is UNSET. Any IO still in flight when a test ends
 * (a forgotten await, an experimentally broken driver during a verification
 * pass) then resolves that fallback and lands in the real folder. Phase 2's
 * seam verification hit exactly this with a deliberately mutated driver, so
 * the guard is no longer hypothetical: with this file, the unset case cannot
 * occur in a test process, and a stray late write can only ever reach a
 * sacrificial directory.
 */
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.FPLAN_DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'fplan-test-guard-'));
