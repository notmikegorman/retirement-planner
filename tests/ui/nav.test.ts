/**
 * Unit tests for the URL half of src/ui/nav.ts — the pure logic under
 * useRoute, which is where a hand-rolled router goes wrong.
 *
 * Four properties are load-bearing, and each one is a real failure mode:
 *
 * 1. PARSING IS TOTAL. Every string in produces a usable route out. A '/' that
 *    resolved to nothing, or a stale /profile/budget that matched no tab, would
 *    render a page with no content — a blank screen instead of a wrong one.
 * 2. THE ROUND TRIP HOLDS. parseRoute(routePath(r)) === r for every view the
 *    app has, or a link to a tab opens on a different tab.
 * 3. SAME URL MEANS REPLACE. Clicking the page you are already on must not push
 *    a history entry; three clicks would otherwise cost three presses of Back
 *    to leave the page, which is how the back button becomes useless.
 * 4. THE URL BEATS localStorage, AND ONLY THE URL. Two sources for one piece of
 *    state need an order, and it has to be the one that makes a shared link
 *    open the same view for the person who receives it.
 *
 * Every expectation below is hand-derived from those rules.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ENTITY_PAGES,
  HOME,
  NETWORTH_TAB_IDS,
  NETWORTH_TAB_STORAGE_KEY,
  PAGES,
  PAGE_TABS,
  RESULTS_TAB_IDS,
  RESULTS_TAB_STORAGE_KEY,
  SEARCH_TAB_IDS,
  SEARCH_TAB_STORAGE_KEY,
  PAGE_TAB_STORAGE_KEY,
  historyAction,
  isEntityPage,
  isResultsTabId,
  isSearchTabId,
  isTabOfPage,
  nextRoute,
  normalizeBase,
  parseRoute,
  resolveTab,
  routePath,
  stripBase,
  withBase,
  type Page,
  type Route,
} from '../../src/ui/nav';

/** Every addressable view in the app: the pages plus each page's tabs. */
const EVERY_ROUTE: Route[] = PAGES.flatMap((page) => [
  { page, tab: null } as Route,
  ...(PAGE_TABS[page] as readonly string[]).map((tab) => ({ page, tab }) as Route),
]);

describe('the vocabulary', () => {
  it('covers the twelve modules: Plan first, the rest alphabetical', () => {
    // The owner's rules (2026-08-30): the old Profile page's tabs each
    // became a module, joined by Plan (id 'workbench' — the label changed,
    // the URL vocabulary did not) and Net worth. Plan sits FIRST, above the
    // sidebar separator; everything after it is alphabetized. 'search' is
    // still addressable but draws no sidebar item, and 'settings' renders in
    // the sidebar footer; App.tsx carries both rules. 'dashboard',
    // 'methodology', 'profile' and 'health' (its fields moved onto the
    // Settings page the same day) are tombstones, asserted with the
    // unknown/legacy paths below.
    expect([...PAGES]).toEqual([
      'workbench',
      'accounts',
      'expenses',
      'home',
      'household',
      'income',
      'insurance',
      'investing',
      'networth',
      'search',
      'settings',
      'tithing',
    ]);
    // Alphabetical below Plan is the rule, not a coincidence of the list.
    const rest = [...PAGES].slice(1);
    expect(rest).toEqual([...rest].sort());
  });

  it('names the entity pages — the ones whose second segment is a record id', () => {
    expect([...ENTITY_PAGES]).toEqual(['accounts', 'insurance']);
    expect(isEntityPage('accounts')).toBe(true);
    expect(isEntityPage('workbench')).toBe(false);
    // An entity page's PAGE_TABS list stays empty: its segment is a record,
    // not a tab, and EVERY_ROUTE above must not try to enumerate records.
    for (const page of ENTITY_PAGES) expect([...PAGE_TABS[page]]).toEqual([]);
  });

  it('gives every page a tab list, and only the tabbed pages a non-empty one', () => {
    // A page missing from PAGE_TABS would throw on the lookup in parseRoute.
    expect(Object.keys(PAGE_TABS).sort()).toEqual([...PAGES].sort());
    expect([...PAGE_TABS.workbench]).toEqual([...RESULTS_TAB_IDS]);
    expect([...PAGE_TABS.search]).toEqual([...SEARCH_TAB_IDS]);
    expect([...PAGE_TABS.networth]).toEqual([...NETWORTH_TAB_IDS]);
    expect([...PAGE_TABS.household]).toEqual([]);
  });

  it('names the tabs the pages actually offer', () => {
    // Hand-listed rather than derived, so renaming a tab id — which silently
    // breaks every link anyone has saved to it — has to be done on purpose.
    // Summary split three ways and Widow moved LAST (both the owner's
    // calls, 2026-08-30) — nav.ts's RESULTS_TAB_IDS comment carries why.
    expect([...RESULTS_TAB_IDS]).toEqual([
      'summary',
      'details',
      'withdrawals',
      'outlook',
      'tithing',
      'taxes',
      'cashflow',
      'explore',
      'widow',
      'history',
    ]);
    expect([...SEARCH_TAB_IDS]).toEqual(['space', 'progress', 'report', 'history']);
    // Three, not four: the snapshots table moved under the bars on the trend
    // panel (the owner's relocation, 2026-09-03), and a tab whose panel has
    // been emptied into another one is not a tab.
    expect([...NETWORTH_TAB_IDS]).toEqual(['trend', 'score', 'spend']);
  });

  it('is URL-safe and free of duplicates within a page', () => {
    // A segment needing percent-encoding, or two buttons claiming one path.
    for (const page of PAGES) {
      const ids = [...(PAGE_TABS[page] as readonly string[])];
      for (const id of ids) expect(id).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).not.toContain(page);
    }
    for (const page of PAGES) expect(page).toMatch(/^[a-z][a-z0-9-]*$/);
  });

  it('lets a module and a tab share a name, because the segment is read per page', () => {
    // /tithing (the giving module) and /workbench/tithing (what the plan
    // gives) are different views; the pair, not the segment, is the address.
    expect(isTabOfPage('workbench', 'tithing')).toBe(true);
    expect(PAGES).toContain('tithing');
    expect(isTabOfPage('search', 'tithing')).toBe(false);
    expect(isTabOfPage('networth', 'tithing')).toBe(false);
  });

  it('keeps the storage keys it had before the URL existed', () => {
    // A session in flight when this shipped must keep its place: a new key
    // would drop every reader back on the first tab of every page.
    expect(RESULTS_TAB_STORAGE_KEY).toBe('fplan-results-tab');
    expect(SEARCH_TAB_STORAGE_KEY).toBe('fplan-search-tab');
    // Newer than the URL (2026-08-30), so its name follows the convention.
    expect(NETWORTH_TAB_STORAGE_KEY).toBe('fplan-networth-tab');
  });
});

describe('parseRoute', () => {
  it("sends '/' to the workbench", () => {
    expect(parseRoute('/')).toEqual({ page: 'workbench', tab: null });
    expect(parseRoute('')).toEqual(HOME);
  });

  it('reads a page from the first segment', () => {
    expect(parseRoute('/expenses')).toEqual({ page: 'expenses', tab: null });
    expect(parseRoute('/search')).toEqual({ page: 'search', tab: null });
    expect(parseRoute('/networth')).toEqual({ page: 'networth', tab: null });
  });

  it('reads a tab from the second segment', () => {
    expect(parseRoute('/workbench/cashflow')).toEqual({ page: 'workbench', tab: 'cashflow' });
    expect(parseRoute('/search/report')).toEqual({ page: 'search', tab: 'report' });
  });

  it("reads a RECORD id from an entity page's second segment, case intact", () => {
    // Held to shape only: whether k401 exists is the module's question. Case
    // is PRESERVED — record ids are user data and the modules match them
    // exactly; lowercasing 'K401' would open the wrong record or none. A
    // segment that cannot be an id at all (junk characters) drops to the
    // table rather than surviving as a path nothing can answer.
    expect(parseRoute('/accounts/k401')).toEqual({ page: 'accounts', tab: 'k401' });
    expect(parseRoute('/accounts/account-2')).toEqual({ page: 'accounts', tab: 'account-2' });
    expect(parseRoute('/insurance/policy-1')).toEqual({ page: 'insurance', tab: 'policy-1' });
    expect(parseRoute('/accounts/K401')).toEqual({ page: 'accounts', tab: 'K401' });
    expect(parseRoute('/accounts/My_401k')).toEqual({ page: 'accounts', tab: 'My_401k' });
    expect(parseRoute('/accounts/roth.2')).toEqual({ page: 'accounts', tab: 'roth.2' });
    expect(parseRoute('/Accounts/K401')).toEqual({ page: 'accounts', tab: 'K401' });
    expect(parseRoute('/accounts/%%%')).toEqual({ page: 'accounts', tab: null });
    expect(parseRoute('/accounts/-nope')).toEqual({ page: 'accounts', tab: null });
  });

  it('maps the retired /profile paths onto the modules its tabs became', () => {
    // The Profile page retired 2026-08-30; its tab ids WERE the module ids.
    // useRoute\'s canonical rewrite cleans the address bar up after this.
    expect(parseRoute('/profile')).toEqual({ page: 'household', tab: null });
    expect(parseRoute('/profile/expenses')).toEqual({ page: 'expenses', tab: null });
    expect(parseRoute('/profile/accounts')).toEqual({ page: 'accounts', tab: null });
    expect(parseRoute('/profile/settings')).toEqual({ page: 'settings', tab: null });
    expect(parseRoute('/profile/budget')).toEqual({ page: 'household', tab: null });
  });

  it('maps the retired /health module onto Settings, where its fields moved', () => {
    // Health stopped being a module 2026-08-30 — its fields live on the
    // Settings page's Health tab now (a LOCAL tab, so the path names the
    // page). Both the module-era and profile-era links resolve.
    expect(parseRoute('/health')).toEqual({ page: 'settings', tab: null });
    expect(parseRoute('/Health/')).toEqual({ page: 'settings', tab: null });
    expect(parseRoute('/profile/health')).toEqual({ page: 'settings', tab: null });
  });

  it('tolerates the ways a path gets typed, pasted, and mangled', () => {
    expect(parseRoute('/expenses/')).toEqual({ page: 'expenses', tab: null });
    expect(parseRoute('workbench/cashflow')).toEqual({ page: 'workbench', tab: 'cashflow' });
    expect(parseRoute('//workbench//cashflow//')).toEqual({
      page: 'workbench',
      tab: 'cashflow',
    });
    expect(parseRoute('/Workbench/Cashflow')).toEqual({ page: 'workbench', tab: 'cashflow' });
    expect(parseRoute('/workbench/cashflow?ref=email')).toEqual({
      page: 'workbench',
      tab: 'cashflow',
    });
    expect(parseRoute('/workbench/cashflow#now')).toEqual({
      page: 'workbench',
      tab: 'cashflow',
    });
  });

  it('resolves an unknown path instead of blanking the screen', () => {
    // Whatever arrives — a typo, a link to a page that was deleted (there used
    // to be /compare, /results, /dashboard and /methodology), a favicon-ish
    // path — lands somewhere real.
    expect(parseRoute('/nonsense')).toEqual(HOME);
    expect(parseRoute('/compare')).toEqual(HOME);
    expect(parseRoute('/results/summary')).toEqual(HOME);
    expect(parseRoute('/dashboard')).toEqual(HOME);
    expect(parseRoute('/methodology')).toEqual(HOME);
    expect(parseRoute('/%%%')).toEqual(HOME);
  });

  it("drops a tab the page does not have, rather than holding a segment nothing renders", () => {
    // 'budget' was never a results tab; 'space' is the Search page's. Both fall
    // back to null, which hands the choice to localStorage and then the first
    // tab — never to an empty panel. Untabbed pages drop every segment.
    expect(parseRoute('/workbench/budget')).toEqual({ page: 'workbench', tab: null });
    expect(parseRoute('/workbench/space')).toEqual({ page: 'workbench', tab: null });
    expect(parseRoute('/networth/summary')).toEqual({ page: 'networth', tab: null });
    expect(parseRoute('/expenses/lines')).toEqual({ page: 'expenses', tab: null });
  });

  it('ignores segments past the tab', () => {
    expect(parseRoute('/workbench/cashflow/2026/extra')).toEqual({
      page: 'workbench',
      tab: 'cashflow',
    });
    expect(parseRoute('/accounts/k401/holdings')).toEqual({ page: 'accounts', tab: 'k401' });
  });
});

describe('routePath', () => {
  it('writes /page and /page/sub — and the ROOT for a bare Plan', () => {
    // Plan is HOME and the root is its address (the owner's call,
    // 2026-08-30): the site root must not redirect anywhere, and the
    // sidebar's Plan item lands on the root URL. Tabbed views keep their
    // named paths.
    expect(routePath({ page: 'workbench', tab: null })).toBe('/');
    // The legacy path canonicalizes to the root, as one fact: parse the old
    // address, write the new one.
    expect(routePath(parseRoute('/workbench'))).toBe('/');
    expect(routePath({ page: 'workbench', tab: 'cashflow' })).toBe('/workbench/cashflow');
    expect(routePath({ page: 'accounts', tab: 'k401' })).toBe('/accounts/k401');
  });

  it('round-trips every view the app has', () => {
    // The property that makes a link work: what the app writes is what it reads.
    for (const route of EVERY_ROUTE) {
      expect(parseRoute(routePath(route))).toEqual(route);
    }
    // Entity details round-trip too, though EVERY_ROUTE cannot enumerate
    // them — including mixed case, which the modules match exactly.
    for (const page of ENTITY_PAGES) {
      for (const id of ['record-9', 'K401', 'My_401k']) {
        const route: Route = { page, tab: id };
        expect(parseRoute(routePath(route))).toEqual(route);
      }
    }
  });

  it('gives every view a distinct path', () => {
    const paths = EVERY_ROUTE.map(routePath);
    expect(new Set(paths).size).toBe(paths.length);
    // 12 pages + 10 results tabs + 4 search tabs + 3 net-worth tabs = 29.
    expect(paths.length).toBe(29);
  });
});

describe('nextRoute', () => {
  const onCashflow: Route = { page: 'workbench', tab: 'cashflow' };
  const onAccount: Route = { page: 'accounts', tab: 'k401' };

  it('keeps the segment you are reading when you name the page you are on', () => {
    // The sidebar item for the current page: a no-op, not a reset. Same URL,
    // which historyAction then makes a replace.
    expect(nextRoute(onCashflow, 'workbench')).toEqual(onCashflow);
    expect(nextRoute(onAccount, 'accounts')).toEqual(onAccount);
  });

  it('names no segment when you leave for another page', () => {
    // The new page's own memory (or its first tab, or its table) decides —
    // this is the only moment localStorage gets a say once the URL is in play.
    expect(nextRoute(onCashflow, 'networth')).toEqual({ page: 'networth', tab: null });
    expect(nextRoute(onAccount, 'workbench')).toEqual({ page: 'workbench', tab: null });
  });

  it('takes an explicit tab, including on the page you are already on', () => {
    expect(nextRoute(onCashflow, 'workbench', 'taxes')).toEqual({
      page: 'workbench',
      tab: 'taxes',
    });
    expect(nextRoute(HOME, 'search', 'report')).toEqual({ page: 'search', tab: 'report' });
  });

  it('takes a record id on an entity page, held to shape and case', () => {
    expect(nextRoute(HOME, 'accounts', 'k401')).toEqual({ page: 'accounts', tab: 'k401' });
    expect(nextRoute(onAccount, 'accounts', 'ira')).toEqual({ page: 'accounts', tab: 'ira' });
    // Record ids are user data, matched exactly by the modules — a
    // hand-edited 'K401' or 'My_401k' must survive the round trip.
    expect(nextRoute(HOME, 'accounts', 'K401')).toEqual({ page: 'accounts', tab: 'K401' });
    expect(nextRoute(HOME, 'accounts', 'My_401k')).toEqual({ page: 'accounts', tab: 'My_401k' });
    expect(nextRoute(HOME, 'accounts', '%%%')).toEqual({ page: 'accounts', tab: null });
    expect(nextRoute(HOME, 'accounts', 'has space')).toEqual({ page: 'accounts', tab: null });
  });

  it('treats an explicit null as "no segment", unlike an omitted one', () => {
    expect(nextRoute(onCashflow, 'workbench', null)).toEqual({ page: 'workbench', tab: null });
    expect(nextRoute(onAccount, 'accounts', null)).toEqual({ page: 'accounts', tab: null });
  });

  it('drops a tab that belongs to another page', () => {
    // Would otherwise write /networth/cashflow — a URL that parses back to
    // /networth, so the address bar and the screen would disagree on reload.
    expect(nextRoute(HOME, 'networth', 'cashflow')).toEqual({ page: 'networth', tab: null });
    expect(nextRoute(HOME, 'workbench', 'household')).toEqual({ page: 'workbench', tab: null });
  });
});

describe('historyAction', () => {
  it('replaces when the URL does not change', () => {
    expect(historyAction('/accounts/k401', '/accounts/k401')).toBe('replace');
    expect(historyAction('/workbench', '/workbench')).toBe('replace');
  });

  it('pushes when it does', () => {
    expect(historyAction('/workbench', '/accounts')).toBe('push');
    expect(historyAction('/accounts/k401', '/accounts/ira')).toBe('push');
  });

  it('makes N clicks on the current page cost one Back, not N', () => {
    // The failure this rule exists for: repeated clicks on the active nav
    // button stacking identical entries.
    const clicks = ['/accounts', '/accounts', '/accounts', '/accounts'];
    const pushes = clicks.filter((path) => historyAction('/accounts', path) === 'push');
    expect(pushes).toEqual([]);
  });
});

describe('resolveTab', () => {
  const ids = RESULTS_TAB_IDS;

  it('takes the tab the URL names, whatever the browser remembers', () => {
    // The rule that makes a link shareable: the recipient's localStorage loses.
    expect(resolveTab('cashflow', ids, 'taxes')).toBe('cashflow');
    expect(resolveTab('widow', ids, null)).toBe('widow');
  });

  it('falls back to localStorage when the URL names no tab', () => {
    // A bare /workbench — a bookmark, or a session that was mid-read when the
    // page moved to URLs. It must not lose its place.
    expect(resolveTab(null, ids, 'taxes')).toBe('taxes');
  });

  it('falls back to the first tab when neither answers', () => {
    expect(resolveTab(null, RESULTS_TAB_IDS, null)).toBe('summary');
    expect(resolveTab(null, SEARCH_TAB_IDS, null)).toBe('space');
  });

  it('ignores junk from either source', () => {
    // A stored value from a tab that has since been renamed, or a hand-typed
    // segment. Case-sensitive on purpose: parseRoute lowercases the path, so
    // anything still capitalised here came from somewhere that was not a URL.
    expect(resolveTab('budget', ids, 'taxes')).toBe('taxes');
    expect(resolveTab('budget', ids, 'nonsense')).toBe('summary');
    expect(resolveTab('', ids, '')).toBe('summary');
    expect(resolveTab('Cashflow', ids, null)).toBe('summary');
  });
});

/**
 * A history stack, a localStorage, and the mount/unmount of one page at a time
 * — assembled from the same pure functions useRoute and App call, in the same
 * order, so a browsing SESSION can be asserted rather than a single decision.
 *
 * It exists because the decisions all passed while the sequence below did not:
 * every tab click writes storage, so a stored tab read at PAGE mount is a read
 * of what this session just wrote. Visiting another page and pressing Back
 * remounts the page, refreshes that read, and the next Back — to a path naming
 * no tab — resolves to the tab it should be leaving. The URL changes and the
 * screen does not, which is the exact failure the URL was added to fix.
 */
class Session {
  private stack: string[];
  private at = 0;
  private storage = new Map<string, string>();
  /** Read at APP load, never again — the property under test. */
  private snapshot: Record<string, string | null> = {};
  private mounted: Page | null = null;

  constructor(path: string, storage: Record<string, string> = {}) {
    for (const [k, v] of Object.entries(storage)) this.storage.set(k, v);
    for (const page of PAGES) {
      const key = PAGE_TAB_STORAGE_KEY[page];
      this.snapshot[page] = key === null ? null : (this.storage.get(key) ?? null);
    }
    // useRoute's mount effect: the address bar is rewritten to what resolved.
    this.stack = [routePath(parseRoute(path))];
    this.mounted = this.route().page;
  }

  get path(): string {
    return this.stack[this.at];
  }
  get depth(): number {
    return this.stack.length;
  }
  route(): Route {
    return parseRoute(this.path);
  }

  /** What the strip shows: App hands the page `route.tab` and the snapshot. */
  tab(): string {
    const page = this.route().page;
    const ids = PAGE_TABS[page] as readonly string[];
    if (ids.length === 0) return '';
    return resolveTab(this.route().tab, ids as [string, ...string[]], this.snapshot[page]);
  }

  /** A tab button: writes storage, then navigates. */
  click(tab: string): this {
    const page = this.route().page;
    const key = PAGE_TAB_STORAGE_KEY[page];
    if (key !== null) this.storage.set(key, tab);
    return this.navigate(page, tab);
  }

  /** A top-strip button: names the page and no tab. */
  go(page: Page): this {
    return this.navigate(page, undefined);
  }

  private navigate(page: Page, tab: string | undefined): this {
    const path = routePath(nextRoute(this.route(), page, tab));
    if (historyAction(this.path, path) === 'push') {
      this.stack = [...this.stack.slice(0, this.at + 1), path];
      this.at = this.stack.length - 1;
    } else {
      this.stack[this.at] = path;
    }
    this.remount();
    return this;
  }

  back(): this {
    if (this.at > 0) this.at -= 1;
    this.remount();
    return this;
  }

  /**
   * Leaving a page unmounts it and returning mounts it again. The snapshot must
   * NOT be refreshed here — that refresh is the bug.
   */
  private remount(): void {
    this.mounted = this.route().page;
  }

  get page(): Page | null {
    return this.mounted;
  }
}

describe('a browsing session', () => {
  it('changes the screen every time Back changes the URL, across a page visit', () => {
    // The reproduction, one press at a time. Storage says 'summary' at load.
    const s = new Session('/', { 'fplan-results-tab': 'summary' });
    // A bare Plan's canonical path is the ROOT (2026-08-30).
    expect([s.path, s.tab()]).toEqual(['/', 'summary']);

    s.click('cashflow');
    expect([s.path, s.tab(), s.depth]).toEqual(['/workbench/cashflow', 'cashflow', 2]);

    // Away and back: the Workbench unmounts and mounts again, and storage now
    // holds the 'cashflow' the click above wrote.
    s.go('accounts');
    expect([s.path, s.page, s.depth]).toEqual(['/accounts', 'accounts', 3]);
    s.back();
    expect([s.path, s.tab()]).toEqual(['/workbench/cashflow', 'cashflow']);

    // The press that used to move the URL and nothing else.
    s.back();
    expect(s.path).toBe('/');
    expect(s.tab()).toBe('summary');
  });

  it('keeps the URL ahead of storage the whole way, so a link still wins', () => {
    // The other half: the snapshot must not start OVERRIDING the path either.
    const s = new Session('/search/report', { 'fplan-search-tab': 'space' });
    expect(s.tab()).toBe('report');
    s.go('workbench').back();
    expect([s.path, s.tab()]).toEqual(['/search/report', 'report']);
  });

  it('costs one Back to leave a page however many times its button is clicked', () => {
    const s = new Session('/workbench/cashflow');
    s.go('workbench').go('workbench').go('workbench');
    expect([s.path, s.depth]).toEqual(['/workbench/cashflow', 1]);
    expect(s.tab()).toBe('cashflow');
  });

  it('drops the forward entries a new navigation supersedes', () => {
    // Back, then somewhere else: the abandoned branch must not stay reachable.
    const s = new Session('/workbench');
    s.click('cashflow').go('accounts').back().go('networth');
    expect([s.path, s.depth]).toEqual(['/networth', 3]);
  });
});

describe('the per-page tab guards', () => {
  it('accept only the ids of the page they belong to', () => {
    expect(isResultsTabId('cashflow')).toBe(true);
    expect(isResultsTabId('household')).toBe(false);
    expect(isResultsTabId(null)).toBe(false);
    expect(isSearchTabId('report')).toBe(true);
    expect(isSearchTabId('explore')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Invariants read straight out of the sources
// ---------------------------------------------------------------------------

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

describe('the pages render the vocabulary they are addressed by', () => {
  const app = read('../../src/ui/App.tsx');
  const searchPage = read('../../src/ui/pages/SearchPage.tsx');
  const workbenchPage = read('../../src/ui/pages/WorkbenchPage.tsx');
  const liveResults = read('../../src/ui/components/workbench/LiveResults.tsx');
  const server = read('../../src/server/server.ts');

  /** The keys of a `Record<XTabId, string>` label map, in source order. */
  function labelKeys(source: string, declaration: string): string[] {
    const start = source.indexOf(declaration);
    expect(start).toBeGreaterThanOrEqual(0);
    const body = source.slice(start, source.indexOf('};', start));
    return [...body.matchAll(/^ {2}([a-z][a-z0-9]*):/gm)].map((m) => m[1]);
  }

  it('labels every page and every tab, in the order the URL vocabulary lists', () => {
    // The strips are rendered by mapping over the id tuples, so a label map
    // that disagreed would put a button in the wrong place (TypeScript already
    // rejects a missing or unknown key; only the ORDER can drift silently).
    expect(labelKeys(app, 'const NAV_LABELS')).toEqual([...PAGES]);
    expect(labelKeys(searchPage, 'const TAB_LABELS')).toEqual([...SEARCH_TAB_IDS]);
    expect(labelKeys(liveResults, 'const TAB_LABELS')).toEqual([...RESULTS_TAB_IDS]);
  });

  it('maps over the id tuples rather than a second list of its own', () => {
    // The bug this forbids: a tab strip built from a local array, so a page has
    // a button whose id no path can name (or a path that renders nothing).
    expect(app).toContain('PAGES.map');
    expect(searchPage).toContain('SEARCH_TAB_IDS.map');
    expect(liveResults).toContain('RESULTS_TAB_IDS.map');
  });

  it('has a server that answers deep links with the app', () => {
    // Without the SPA fallback, every path this file invents 404s on refresh —
    // the URL would be writable but not loadable. API 404s must stay JSON.
    expect(server).toContain('setNotFoundHandler');
    expect(server).toContain("req.url.startsWith('/api/')");
    expect(server).toContain("reply.sendFile('index.html')");
  });

  it('reads the remembered tab once, above the pages, not inside them', () => {
    // The session test above proves WHY: a page that reads storage at its own
    // mount re-reads it on the way back through, and Back stops changing the
    // screen. Only nav.ts may call readStoredTab; pages take the snapshot as a
    // prop. Enforced here because nothing else can — a page is free to import
    // it, and the resulting bug only shows up three navigations in.
    for (const [name, source] of [
      ['SearchPage', searchPage],
      ['WorkbenchPage', workbenchPage],
      ['LiveResults', liveResults],
      ['App', app],
      ['AccountsModule', read('../../src/ui/modules/AccountsModule.tsx')],
      ['InsuranceModule', read('../../src/ui/modules/InsuranceModule.tsx')],
    ] as const) {
      expect(`${name}: ${source.includes('readStoredTab(')}`).toBe(`${name}: false`);
    }
    expect(app).toContain('storedTabs[page]');
  });
});

/**
 * The hook's wiring, read as text.
 *
 * These are weaker than the tests above and deliberately kept apart from them:
 * they assert the code SAYS the right thing, not that it DOES it. useRoute
 * touches window.history and window.location, so exercising it needs a DOM this
 * repo's node test environment does not have (the same reason server.ts's SPA
 * fallback is pinned by a grep above rather than a request).
 *
 * They earn their place anyway, because every one of them was written against a
 * mutation that the whole 1,300-test suite passed: delete the popstate
 * listener, make every navigation a replace, or drop the load-time rewrite, and
 * nothing else in this repo notices. A DOM-based test of useRoute would replace
 * all three, and should, the day a DOM environment arrives.
 */
describe('the base path helpers', () => {
  it('normalizeBase: Vite BASE_URL forms → a strippable prefix', () => {
    expect(normalizeBase('/')).toBe('');
    expect(normalizeBase('')).toBe('');
    expect(normalizeBase(undefined)).toBe('');
    expect(normalizeBase('/retirement-planner/')).toBe('/retirement-planner');
    expect(normalizeBase('/retirement-planner')).toBe('/retirement-planner');
    expect(normalizeBase('retirement-planner/')).toBe('/retirement-planner');
  });

  it('stripBase reads served pathnames back into app paths', () => {
    const b = '/retirement-planner';
    expect(stripBase('/retirement-planner/', b)).toBe('/');
    expect(stripBase('/retirement-planner', b)).toBe('/');
    expect(stripBase('/retirement-planner/workbench/cashflow', b)).toBe('/workbench/cashflow');
    // Root builds: the identity, byte for byte.
    expect(stripBase('/workbench', '')).toBe('/workbench');
  });

  it('a prefix-LOOKALIKE path is not stripped — /retirement-planner-x is not ours', () => {
    expect(stripBase('/retirement-planner-x/workbench', '/retirement-planner')).toBe(
      '/retirement-planner-x/workbench',
    );
  });

  it('withBase writes app paths back under the served prefix', () => {
    expect(withBase('/workbench', '/retirement-planner')).toBe(
      '/retirement-planner/workbench',
    );
    // The app ROOT writes the BARE base — no trailing slash (the owner's
    // ask, 2026-08-30): Plan's address on the deployed site is
    // .../retirement-planner, and stripBase above reads both forms back as
    // '/', so a host directory-redirect on refresh trims itself back out.
    expect(withBase('/', '/retirement-planner')).toBe('/retirement-planner');
    expect(withBase('/', '')).toBe('/');
    expect(withBase('/profile/expenses', '')).toBe('/profile/expenses');
  });

  it('the two directions round-trip for every route in the vocabulary', () => {
    for (const base of ['', '/retirement-planner']) {
      for (const route of EVERY_ROUTE) {
        const path = routePath(route);
        expect(stripBase(withBase(path, base), base)).toBe(path);
        expect(parseRoute(stripBase(withBase(path, base), base))).toEqual(route);
      }
    }
  });

  it('an UNBASED deep link parsed under a base resolves rather than blanking', () => {
    // The 404 trick serves the app for any in-site path; a stale bookmark to
    // the OLD root-served shape must still land somewhere.
    expect(parseRoute(stripBase('/workbench', '/retirement-planner'))).toEqual({
      page: 'workbench',
      tab: null,
    });
  });
});

describe('useRoute wires the History API', () => {
  const nav = read('../../src/ui/nav.ts');

  it('listens for popstate, so Back changes the screen and not just the URL', () => {
    expect(nav).toContain("window.addEventListener('popstate', onPopState)");
    expect(nav).toContain("window.removeEventListener('popstate', onPopState)");
    // Re-read, never written: writing here would fight the stack it reports.
    expect(nav).toContain('setRoute(parseRoute(stripBase(window.location.pathname, base)))');
  });

  it('PUSHES a new path and only replaces a repeat, so Back has somewhere to go', () => {
    // If this branch ever replaced too, the back button would be inert and
    // every pure test in this file would still pass.
    expect(nav).toContain(
      "if (action === 'replace') window.history.replaceState(null, '', withBase(path, base))",
    );
    expect(nav).toContain("else window.history.pushState(null, '', withBase(path, base))");
    expect(nav).toContain("const action = opts?.replace === true ? 'replace' : historyAction(");
  });

  it('rewrites the address bar to the resolved path on load, with replace', () => {
    // '/' and '/nonsense' both render the workbench; without this the address
    // bar keeps saying something the app is not showing. A push instead would
    // make the first Back land on the view already on screen.
    expect(nav).toContain("window.history.replaceState(null, '', canonical)");
    expect(nav).toContain('const canonical = withBase(routePath(route), base)');
  });

  it('every read strips the base and every write prepends it — no bare escape', () => {
    // The Pages deploy serves under /retirement-planner/; one forgotten
    // stripBase reads the repo name as a page (everything resolves to the
    // workbench), one forgotten withBase pushStates the address bar straight
    // out of the site. Pin all four crossings.
    expect(nav).toContain('parseRoute(stripBase(window.location.pathname, base))');
    expect(nav).toContain('const here = stripBase(window.location.pathname, base)');
    expect(nav.match(/withBase\(/g)!.length).toBeGreaterThanOrEqual(3);
  });

  it('snapshots every page\'s remembered tab once, at app load', () => {
    expect(nav).toContain('const [storedTabs] = useState<StoredTabs>');
    expect(Object.keys(PAGE_TAB_STORAGE_KEY).sort()).toEqual([...PAGES].sort());
    expect(PAGE_TAB_STORAGE_KEY.workbench).toBe(RESULTS_TAB_STORAGE_KEY);
    expect(PAGE_TAB_STORAGE_KEY.search).toBe(SEARCH_TAB_STORAGE_KEY);
    expect(PAGE_TAB_STORAGE_KEY.networth).toBe(NETWORTH_TAB_STORAGE_KEY);
    // The untabbed pages have nothing to remember, and the entity pages
    // deliberately none either: a remembered RECORD would reopen a detail
    // the user last looked at days ago, when a bare /accounts should mean
    // the table.
    expect(PAGE_TAB_STORAGE_KEY.household).toBeNull();
    expect(PAGE_TAB_STORAGE_KEY.accounts).toBeNull();
    expect(PAGE_TAB_STORAGE_KEY.insurance).toBeNull();
  });
});
