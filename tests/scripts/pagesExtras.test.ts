/**
 * The Pages extras (scripts/pagesExtras.ts): the 404 deep-link trick and
 * the generated service worker. These are deploy artifacts — the lane
 * deliberately never RUNS the worker (registration is opt-in per build and
 * the walkthrough asserts zero registrations), so generation is where the
 * contract gets pinned:
 *
 *   - 404.html is a byte copy of index.html (the whole trick);
 *   - the precache lists exactly the built files (404.html in, sw.js out);
 *   - the /api/ guard exists — the one line whose silent loss would let a
 *     cache answer legacy-mode API calls with stale records;
 *   - no skipWaiting outside the SKIP_WAITING message handler — the line
 *     between "update on the user's click" and "silent mid-session swap";
 *   - the version is a digest of the bytes: rebuild-same ⇒ same worker,
 *     change-anything ⇒ new worker.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateServiceWorkerSource, writePagesExtras } from '../../scripts/pagesExtras';

let dist: string;

async function seedDist(dir: string): Promise<void> {
  await fs.mkdir(path.join(dir, 'assets'), { recursive: true });
  await fs.writeFile(path.join(dir, 'index.html'), '<!doctype html><title>t</title>');
  await fs.writeFile(path.join(dir, 'assets', 'index-abc.js'), 'console.log(1)');
  await fs.writeFile(path.join(dir, 'manifest.webmanifest'), '{}');
}

beforeAll(async () => {
  dist = await fs.mkdtemp(path.join(os.tmpdir(), 'fplan-pages-extras-'));
  await seedDist(dist);
  await writePagesExtras(dist);
});

afterAll(async () => {
  await fs.rm(dist, { recursive: true, force: true });
});

describe('the 404 trick', () => {
  it('404.html is a byte copy of index.html', async () => {
    const index = await fs.readFile(path.join(dist, 'index.html'));
    const notFound = await fs.readFile(path.join(dist, '404.html'));
    expect(Buffer.compare(index, notFound)).toBe(0);
  });
});

describe('the generated service worker', () => {
  it('precaches every built file — 404.html included, itself excluded', async () => {
    const sw = await fs.readFile(path.join(dist, 'sw.js'), 'utf8');
    const precache = /const PRECACHE = (\[[\s\S]*?\]);/.exec(sw);
    expect(precache).not.toBeNull();
    const files = JSON.parse(precache![1]) as string[];
    expect(files).toEqual(['404.html', 'assets/index-abc.js', 'index.html', 'manifest.webmanifest']);
  });

  it('never touches /api/ — legacy-mode traffic must always hit the server', async () => {
    const sw = await fs.readFile(path.join(dist, 'sw.js'), 'utf8');
    expect(sw).toContain("if (url.pathname.includes('/api/')) return;");
  });

  it('waits by default: skipWaiting appears ONLY inside the message handler', () => {
    const sw = generateServiceWorkerSource(['index.html'], 'v');
    const occurrences = sw.match(/skipWaiting\(\)/g) ?? [];
    expect(occurrences).toHaveLength(1);
    const messageHandler = /self\.addEventListener\('message'[\s\S]*?\}\);/.exec(sw)![0];
    expect(messageHandler).toContain("event.data.type === 'SKIP_WAITING'");
    expect(messageHandler).toContain('self.skipWaiting()');
    // The install handler must NOT activate early (its comment may NAME
    // skipWaiting — the assertion is about the call).
    const installHandler = /self\.addEventListener\('install'[\s\S]*?\}\);/.exec(sw)![0];
    expect(installHandler).not.toContain('skipWaiting()');
  });

  it('the version digests the bytes: same input, same worker; new bytes, new worker', async () => {
    const first = await fs.readFile(path.join(dist, 'sw.js'), 'utf8');
    await writePagesExtras(dist);
    const again = await fs.readFile(path.join(dist, 'sw.js'), 'utf8');
    expect(again).toBe(first);

    await fs.writeFile(path.join(dist, 'assets', 'index-abc.js'), 'console.log(2)');
    await writePagesExtras(dist);
    const changed = await fs.readFile(path.join(dist, 'sw.js'), 'utf8');
    expect(changed).not.toBe(first);

    const versionOf = (s: string) => /const VERSION = "([0-9a-f]{16})";/.exec(s)![1];
    expect(versionOf(changed)).not.toBe(versionOf(first));
  });

  it('serves the app shell for navigations and precache-first for assets', () => {
    const sw = generateServiceWorkerSource(['index.html'], 'v');
    expect(sw).toContain("request.mode === 'navigate'");
    expect(sw).toContain("new URL('index.html', self.location.href)");
    expect(sw).toContain('caches.match(request).then((hit) => hit || fetch(request))');
  });
});
