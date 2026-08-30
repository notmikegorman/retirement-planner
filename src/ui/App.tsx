import { PAGES, useRoute, type Page } from './nav';
import { useSwUpdate } from './pwa';
import { ThemeContext, themeModeIcon, themeModeLabel, useThemeController } from './theme';
import { ToastProvider } from './toast';
import { FolderControl } from './components/topbar/FolderControl';
import { WorkbenchPage } from './pages/WorkbenchPage';
import { SearchPage } from './pages/SearchPage';
import { ProfilePage } from './pages/ProfilePage';
import { NetWorthPage } from './pages/NetWorthPage';

/**
 * The Workbench is first and is where the app opens: turning the knobs and
 * seeing what they do are the same activity, so they are the same page. The old
 * Scenarios and Results pages — edit here, save, navigate there, run — are still
 * gone, and so is Compare: there is one plan, and its HISTORY lives inside the
 * Workbench's own input panel, where restoring a version replaces that plan.
 *
 * Search sits second, next to the workbench it feeds. It is a page rather than
 * a workbench tab because it runs for tens of minutes on the server, describes
 * hundreds of plans that are not on screen, and produces a wide document; see
 * the header of SearchPage.tsx.
 *
 * The strip's ORDER is PAGES in nav.ts, because that list is also the URL
 * vocabulary; these are the labels for it, and a page with no label here fails
 * to compile rather than shipping a nameless button.
 */
const NAV_LABELS: Record<Page, string> = {
  workbench: 'Workbench',
  search: 'Search',
  profile: 'Profile',
  networth: 'Net Worth',
};

/**
 * Pages that stay in the URL vocabulary but draw no top-strip button. Search
 * is parked here (owner's call, 2026-08-30): the whole module — page, server
 * machinery, /search paths — keeps working for whoever types the URL, but the
 * strip stops advertising it. Deleting it from this set is the entire
 * un-parking operation.
 */
const NAV_HIDDEN: ReadonlySet<Page> = new Set(['search']);

/**
 * The service worker's update affordance (Phase 7): visible exactly while a
 * new version is installed and waiting, gone otherwise. The reload is the
 * ONLY way a live session moves to the new bundle — never a silent swap —
 * and the beforeunload guards still warn if a scoring run or search is in
 * flight when the button is pressed.
 */
function SwUpdateBar() {
  const activate = useSwUpdate();
  if (activate === null) return null;
  return (
    <div className="sw-update-bar" role="status">
      <span>A new version of the planner is ready.</span>
      <button className="primary" onClick={activate}>
        Reload to update
      </button>
    </div>
  );
}

export function App() {
  const { route, navigate, storedTabs } = useRoute();
  const page = route.page;
  const theme = useThemeController();

  // Only the page in `route` renders, so it is the only snapshot anyone needs.
  const props = { navigate, route, storedTab: storedTabs[page] };

  return (
    <ThemeContext.Provider value={theme}>
      <ToastProvider>
        <div className="app">
          <header className="topbar">
            <div className="brand">Retirement Planner</div>
            <nav>
              {PAGES.map((item) => NAV_HIDDEN.has(item) ? null : (
                <button
                  key={item}
                  className={page === item ? 'nav-btn active' : 'nav-btn'}
                  /*
                    No tab argument: arriving from another page names none and
                    lets that page's memory choose, and clicking the page you
                    are already on keeps the tab you are reading — which makes
                    the URL identical, which makes it a replace, not a push.
                  */
                  onClick={() => navigate(item)}
                >
                  {NAV_LABELS[item]}
                </button>
              ))}
            </nav>
            <span className="spacer" />
            {/* Where the data on screen lives, and the door to anywhere else
                it could (File > New / File > Open) — FolderControl.tsx. */}
            <FolderControl />
            <button
              className="theme-toggle"
              onClick={theme.cycleMode}
              title={`Theme: ${themeModeLabel(theme.mode)} — click to change`}
              aria-label={`Theme: ${themeModeLabel(theme.mode)}. Click to switch.`}
            >
              <span aria-hidden="true">{themeModeIcon(theme.mode)}</span>
              {themeModeLabel(theme.mode)}
            </button>
          </header>
          {/*
            The workbench is two columns and the search report is a wide
            document (a forest plot, an eight-column finalists table); both get
            the wider content box.
          */}
          <main className={page === 'workbench' || page === 'search' ? 'content wide' : 'content'}>
            {page === 'workbench' && <WorkbenchPage {...props} />}
            {page === 'search' && <SearchPage {...props} />}
            {page === 'profile' && <ProfilePage {...props} />}
            {page === 'networth' && <NetWorthPage {...props} />}
          </main>
          <SwUpdateBar />
        </div>
      </ToastProvider>
    </ThemeContext.Provider>
  );
}
