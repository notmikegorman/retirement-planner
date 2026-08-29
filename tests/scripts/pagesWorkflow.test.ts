/**
 * THE DEPLOY GATE (.github/workflows/pages.yml + the build:pages recipe).
 *
 * Nothing executes a workflow file until it runs on GitHub, so the lines
 * that decide WHETHER and WHAT to deploy are pinned here the way
 * nav.test.ts pins useRoute's history wiring: by reading the file. Each
 * pin names the failure its silent loss would ship:
 *
 *   THE GATE — pages.yml deploys only when a ci run CONCLUDED SUCCESS on
 *   main, from that run's exact head_sha. Lose the `if:` and every red ci
 *   run still deploys; lose the head_sha ref and the deploy builds
 *   whatever main moved to since the tests passed — both are "the site
 *   ships untested code," the one thing the workflow exists to prevent.
 *
 *   THE LINK — workflow_run matches ci.yml by its `name:`. Rename either
 *   half and deploys silently stop forever; there is no error, just a
 *   site that never updates again.
 *
 *   THE RECIPE — build:pages is the single line that flips the shipped
 *   defaults (base path, local backend, service worker). The walkthrough
 *   lane executes the same recipe through the same env vars; this pin
 *   keeps the recipe itself from drifting to something the lane no longer
 *   emulates. vite.config's env-driven `base:` is pinned for the same
 *   reason — the workflow's FPLAN_BASE lands nowhere else.
 *
 *   THE FLOOR — pages/id-token write permissions (deploy-pages needs
 *   both), contents read (nothing here may push), and a no-cancel
 *   concurrency group (a killed deploy can leave the site half-old
 *   half-new — the staleness class the versioned precache exists to
 *   prevent).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const read = (rel: string): string => readFileSync(`${repoRoot}/${rel}`, 'utf8');

describe('pages.yml deploys only what ci proved', () => {
  const pages = read('.github/workflows/pages.yml');

  it('fires on ci completion (plus the manual dispatch fallback)', () => {
    expect(pages).toContain('workflow_run:');
    expect(pages).toContain('workflows: [ci]');
    expect(pages).toContain('types: [completed]');
    expect(pages).toContain('workflow_dispatch:');
    // The link's other half: ci.yml must keep the name pages.yml watches.
    expect(read('.github/workflows/ci.yml')).toContain('\nname: ci\n');
  });

  it('deploys only from a SUCCESSFUL ci run on main', () => {
    expect(pages).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(pages).toContain("github.event.workflow_run.head_branch == 'main'");
  });

  it('checks out the exact SHA ci proved, not whatever main moved to', () => {
    expect(pages).toContain('ref: ${{ github.event.workflow_run.head_sha || github.sha }}');
  });

  it('builds with the shipped recipe and uploads the built app', () => {
    expect(pages).toContain('run: npm run build:pages');
    expect(pages).toContain('path: dist/ui');
  });

  it('holds the least permissions that can deploy, and never cancels mid-flight', () => {
    expect(pages).toContain('contents: read');
    expect(pages).toContain('pages: write');
    expect(pages).toContain('id-token: write');
    expect(pages).toContain('group: pages');
    expect(pages).toContain('cancel-in-progress: false');
  });
});

describe('the build:pages recipe and its config seam', () => {
  it('build:pages flips exactly the three shipped defaults, then writes the extras', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts['build:pages']).toBe(
      'FPLAN_BASE=/retirement-planner/ VITE_FPLAN_BACKEND=local VITE_FPLAN_SW=1 vite build && tsx scripts/pagesExtras.ts dist/ui',
    );
  });

  it("vite.config's base comes from FPLAN_BASE — the recipe's env var lands here", () => {
    expect(read('vite.config.ts')).toContain("base: process.env.FPLAN_BASE ?? '/'");
  });
});
