/**
 * UI navigation contract shared by App.tsx and all pages — and, since the app
 * grew an address bar, the URL vocabulary with it.
 *
 * THE URL IS THE NAVIGATION STATE. The page used to live in a useState and
 * every tab in localStorage, which meant a refresh on Profile > Expenses came
 * back on the Workbench, no view could be linked or bookmarked, and the back
 * button did nothing at all. Every view now has a path — /workbench/cashflow,
 * /profile/expenses, /search/report — that useRoute (bottom of this file)
 * reads on load, writes with pushState, and re-reads on popstate.
 *
 * THE SHAPE IS /page/tab: one segment for the page, one optional segment for
 * the tab, drawn from that page's own vocabulary (PAGE_TABS). '/' is the
 * workbench, and so is anything unrecognised — an unknown path resolves rather
 * than blanking the screen.
 *
 * ONE TAB SEGMENT PER PAGE, which means the Workbench's LEFT panel (Plan,
 * Spending, Income, …) is deliberately NOT in the URL while its right-hand
 * results strip is. The right strip names WHICH ANSWER you are reading, which
 * is the thing worth sending someone; the left names where your hands are,
 * which belongs to the machine you are typing on. Its tab stays in
 * localStorage, and the precedence rule below covers it: the URL never names
 * it, so storage always decides.
 *
 * There are still no route params. The app has ONE plan, so there is nothing
 * to preselect when navigating: the plan's history lives inside the Workbench's
 * own panel and restores INTO that one plan, and the Search page remembers
 * which search it is watching in a module-level bookmark rather than in a URL.
 * (There used to be a `scenarioId` — which scenario the Workbench should open —
 * and a `scenarioIds` for the Compare page's checkboxes; neither is needed when
 * there is only ever one plan on screen.)
 */
import { useCallback, useEffect, useState } from 'react';

// ---------------------------------------------------------------------------
// The vocabulary (pure — unit-tested in tests/ui/nav.test.ts)
// ---------------------------------------------------------------------------

/**
 * Pages, in top-strip order; App.tsx says why the strip reads this way.
 * Net Worth sits directly after Profile because it is the profile's ledger:
 * the same accounts, priced and totalled on the days the user chose to look.
 */
export const PAGES = ['workbench', 'search', 'dashboard', 'profile', 'networth', 'methodology'] as const;

export type Page = (typeof PAGES)[number];

/**
 * Tab ids are URL segments now, so they live here rather than beside the
 * buttons that render them: one list per page, in strip order, and each page
 * supplies the labels as a Record keyed by these ids — a tab added here
 * without a label (or a label without a tab) fails to compile, which is the
 * only way to keep a path segment from pointing at a button that isn't there.
 */

/**
 * The Workbench's right-hand strip.
 *
 * Widow sits SECOND, directly after the answer it qualifies. The household
 * score and the survivor's score are one thought — "this works, and here is
 * what it is worth to my spouse if I am not here" — and burying the second half at
 * the end of the strip, behind four views about tax and cashflow, would make
 * the question something you have to go looking for. It is also the one tab
 * that does not run itself (see WidowCard), which is exactly why it must be
 * easy to reach: it only ever shows a number you asked for.
 */
export const RESULTS_TAB_IDS = [
  'summary',
  'widow',
  'outlook',
  'tithing',
  'taxes',
  'cashflow',
  'explore',
] as const;

export const SEARCH_TAB_IDS = ['space', 'progress', 'report', 'history'] as const;

/**
 * 'expenses' keeps its id from before Expenses/Tithing/Insurance were split
 * apart, so a stored tab — and now an old link — still lands somewhere.
 * 'investing' sits with the other two budget tabs: the three of them are one
 * itemised budget cut by category, and scattering them would hide that.
 */
export const PROFILE_TAB_IDS = [
  'household',
  'accounts',
  'home',
  'income',
  'expenses',
  'tithing',
  'investing',
  'insurance',
  'health',
  'settings',
] as const;

export type ResultsTabId = (typeof RESULTS_TAB_IDS)[number];
export type SearchTabId = (typeof SEARCH_TAB_IDS)[number];
export type ProfileTabId = (typeof PROFILE_TAB_IDS)[number];

/**
 * Which vocabulary each page's second segment is drawn from. Ids only have to
 * be unique WITHIN a page — /profile/tithing and /workbench/tithing are two
 * different views and both are legal, because the segment is only ever read
 * against the page in front of it.
 */
export const PAGE_TABS = {
  workbench: RESULTS_TAB_IDS,
  search: SEARCH_TAB_IDS,
  profile: PROFILE_TAB_IDS,
  dashboard: [],
  networth: [],
  methodology: [],
} as const satisfies Record<Page, readonly string[]>;

/** The tabs a given page can name in its path; `never` for the untabbed ones. */
export type TabFor<P extends Page> = (typeof PAGE_TABS)[P][number];

export type TabId = TabFor<Page>;

/** True when `value` is one of THIS page's tabs — the only test of a segment. */
export function isTabOfPage(page: Page, value: string): value is TabId {
  const vocabulary: readonly string[] = PAGE_TABS[page];
  return vocabulary.includes(value);
}

export function isResultsTabId(value: string | null): value is ResultsTabId {
  return value !== null && (RESULTS_TAB_IDS as readonly string[]).includes(value);
}

export function isSearchTabId(value: string | null): value is SearchTabId {
  return value !== null && (SEARCH_TAB_IDS as readonly string[]).includes(value);
}

export function isProfileTabId(value: string | null): value is ProfileTabId {
  return value !== null && (PROFILE_TAB_IDS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Routes (pure)
// ---------------------------------------------------------------------------

export interface Route {
  page: Page;
  /**
   * The tab the PATH names, or null when it names none (a bare /profile, a
   * stale /profile/budget, an untabbed page). Null is not "no tab" — it is
   * "the URL has no opinion", which is what hands the choice to localStorage.
   * See resolveTab.
   */
  tab: TabId | null;
}

/** Where '/' goes, and where anything unrecognised goes. */
export const HOME: Route = { page: 'workbench', tab: null };

/**
 * Read a pathname into a route. Total by construction: every string in, a
 * usable route out.
 *
 * Unknown page, junk segment, extra segments, a trailing slash, a capitalised
 * link someone retyped by hand — all resolve rather than 404, because the only
 * thing worse than the wrong page is a blank one. useRoute rewrites the
 * address bar to the resolved path on load, so a stale link cleans itself up.
 */
export function parseRoute(path: string): Route {
  const segments = path
    .split(/[?#]/)[0]
    .split('/')
    .map((segment) => segment.trim().toLowerCase())
    .filter((segment) => segment.length > 0);

  const page = PAGES.find((candidate) => candidate === segments[0]);
  if (page === undefined) return HOME;

  const raw = segments.length > 1 ? segments[1] : null;
  if (raw === null || !isTabOfPage(page, raw)) return { page, tab: null };
  return { page, tab: raw };
}

/** The canonical path for a route — the only string ever written to history. */
export function routePath(route: Route): string {
  return route.tab === null ? `/${route.page}` : `/${route.page}/${route.tab}`;
}

/**
 * The route a navigate() call lands on.
 *
 * An omitted tab is not the same as an explicit null: staying on the page you
 * are already on KEEPS the tab you are reading (so the top-strip button for the
 * current page is a no-op rather than a reset to Household), while leaving for
 * another page names no tab and lets that page's own memory decide.
 *
 * A tab that does not belong to the page is dropped, not written — a
 * /dashboard/expenses would be a URL that parses back to something else.
 */
export function nextRoute(current: Route, page: Page, tab?: string | null): Route {
  const wanted = tab === undefined ? (page === current.page ? current.tab : null) : tab;
  if (wanted === null || !isTabOfPage(page, wanted)) return { page, tab: null };
  return { page, tab: wanted };
}

/**
 * Push a history entry, or replace the one that is there?
 *
 * Navigating to the URL you are already on must REPLACE. Clicking "Profile"
 * three times while on Profile would otherwise cost three presses of Back to
 * leave the page, which is exactly how a hand-rolled router's back button
 * becomes useless.
 */
export function historyAction(currentPath: string, nextPath: string): 'push' | 'replace' {
  return currentPath === nextPath ? 'replace' : 'push';
}

// ---------------------------------------------------------------------------
// Tab precedence (pure)
// ---------------------------------------------------------------------------

/**
 * Tab storage keys, unchanged from before the URL existed so a session in
 * flight keeps its place on the first load after this change.
 */
export const RESULTS_TAB_STORAGE_KEY = 'fplan-results-tab';
export const SEARCH_TAB_STORAGE_KEY = 'fplan-search-tab';
export const PROFILE_TAB_STORAGE_KEY = 'fplan-profile-tab';

/**
 * THE PRECEDENCE RULE, in one function, because two sources of truth for one
 * piece of state is how this kind of code rots:
 *
 *   1. THE URL WINS whenever the path names a tab this page has. A link to
 *      /profile/expenses opens on Expenses for whoever clicks it, no matter
 *      what their browser remembers.
 *   2. localStorage answers only when the path names none — a bare /profile, a
 *      link to a tab that has since been renamed, or the Workbench's left-hand
 *      panel, whose tab the URL never names at all. This is what keeps an
 *      existing session from losing its place.
 *   3. The first tab in the strip when neither answers.
 *
 * Nothing else picks a tab. A page that wants to switch tabs navigates (which
 * writes the URL) rather than setting state, so there is never a moment where
 * the strip and the address bar disagree.
 */
export function resolveTab<T extends string>(
  fromUrl: string | null,
  ids: readonly [T, ...T[]],
  fromStorage: string | null,
): T {
  const known = (value: string | null): value is T =>
    value !== null && (ids as readonly string[]).includes(value);
  if (known(fromUrl)) return fromUrl;
  if (known(fromStorage)) return fromStorage;
  return ids[0];
}

/** Which key holds a page's remembered tab; null for the untabbed pages. */
export const PAGE_TAB_STORAGE_KEY = {
  workbench: RESULTS_TAB_STORAGE_KEY,
  search: SEARCH_TAB_STORAGE_KEY,
  profile: PROFILE_TAB_STORAGE_KEY,
  dashboard: null,
  networth: null,
  methodology: null,
} as const satisfies Record<Page, string | null>;

/**
 * localStorage read that survives storage being disabled (private windows).
 *
 * Read it ONCE PER APP LOAD — useRoute does, and hands the answer down. The
 * scope matters: a page component's own mount is NOT good enough, because a
 * page unmounts every time you visit another one. On /workbench/cashflow ->
 * Profile -> Back -> Back, the Workbench remounts on the first Back and its
 * fresh read returns the 'cashflow' the tab click had written, so the second
 * Back reaches the bare /workbench and resolves right back to cashflow — the
 * URL changes and the screen does not. Snapshotting at app load pins the answer
 * to what storage said before this session started writing to it.
 */
export function readStoredTab(key: string): string | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStoredTab(key: string, id: string): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(key, id);
  } catch {
    // Storage disabled: the URL still carries the tab, so only the fallback
    // for a URL that names none is lost.
  }
}

// ---------------------------------------------------------------------------
// The hook (browser-only; the logic above is what the tests exercise)
// ---------------------------------------------------------------------------

export type NavigateFn = <P extends Page>(
  page: P,
  tab?: TabFor<P> | null,
  opts?: { replace?: boolean },
) => void;

export interface PageProps {
  navigate: NavigateFn;
  /** The path's opinion. Pages turn it into a tab with resolveTab(). */
  route: Route;
  /**
   * What storage said for THIS page at app load, for a path that names no tab.
   * A page must not read storage itself: see readStoredTab for the Back button
   * that a per-page read breaks.
   */
  storedTab: string | null;
}

/** The remembered tab of every page, frozen at app load. See readStoredTab. */
export type StoredTabs = Record<Page, string | null>;

/**
 * The History API glue: the current route, and the one way to change it.
 *
 * `navigate` is stable for the life of the app — it reads the current route
 * back out of window.location rather than closing over state, so it can sit in
 * an effect's dependency list (SearchPage's does) without re-arming it.
 */
export function useRoute(): { route: Route; navigate: NavigateFn; storedTabs: StoredTabs } {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.pathname));

  /*
   * Once, here, for every page at the same moment — not in each page, which
   * re-reads on every remount and un-breaks nothing. readStoredTab has the
   * sequence this ordering exists to survive.
   */
  const [storedTabs] = useState<StoredTabs>(() =>
    Object.fromEntries(
      PAGES.map((page) => {
        const key = PAGE_TAB_STORAGE_KEY[page];
        return [page, key === null ? null : readStoredTab(key)];
      }),
    ) as StoredTabs,
  );

  useEffect(() => {
    /*
     * The address bar can disagree with the route it resolved to: '/' is the
     * workbench, '/Profile' is /profile, '/nonsense' is the workbench too, and
     * '/profile/budget' is a tab that no longer exists. Write the resolved
     * answer back so the URL always says what is on screen — with REPLACE,
     * because a push on load would make the first Back a no-op that lands on
     * the view you are already looking at.
     *
     * Mount only: every write after this one goes through navigate().
     */
    const canonical = routePath(route);
    if (window.location.pathname !== canonical) {
      window.history.replaceState(null, '', canonical);
    }
  }, []);

  useEffect(() => {
    /*
     * The back button is the point of all this. The browser has already changed
     * the URL by the time popstate fires, so the route is RE-READ here and
     * never written — writing would fight the history stack it is reporting.
     */
    const onPopState = () => setRoute(parseRoute(window.location.pathname));
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const navigate = useCallback<NavigateFn>((page, tab, opts) => {
    const here = window.location.pathname;
    const next = nextRoute(parseRoute(here), page, tab);
    const path = routePath(next);
    /*
     * `replace` is for a view change the USER did not ask for — the Search page
     * swapping itself to the report when a run it started finishes. Those must
     * not leave an entry, or Back walks through views nobody chose.
     */
    const action = opts?.replace === true ? 'replace' : historyAction(here, path);
    if (action === 'replace') window.history.replaceState(null, '', path);
    else window.history.pushState(null, '', path);
    setRoute(next);
  }, []);

  return { route, navigate, storedTabs };
}
