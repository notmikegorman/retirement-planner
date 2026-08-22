import { PAGES, useRoute, type Page } from './nav';
import { ThemeContext, themeModeIcon, themeModeLabel, useThemeController } from './theme';
import { ToastProvider } from './toast';
import { WorkbenchPage } from './pages/WorkbenchPage';
import { SearchPage } from './pages/SearchPage';
import { DashboardPage } from './pages/DashboardPage';
import { ProfilePage } from './pages/ProfilePage';
import { NetWorthPage } from './pages/NetWorthPage';
import { MethodologyPage } from './pages/MethodologyPage';

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
  dashboard: 'Dashboard',
  profile: 'Profile',
  networth: 'Net Worth',
  methodology: 'Methodology',
};

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
            <div className="brand">Finance Planner</div>
            <nav>
              {PAGES.map((item) => (
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
            {page === 'dashboard' && <DashboardPage {...props} />}
            {page === 'profile' && <ProfilePage {...props} />}
            {page === 'networth' && <NetWorthPage {...props} />}
            {page === 'methodology' && <MethodologyPage {...props} />}
          </main>
        </div>
      </ToastProvider>
    </ThemeContext.Provider>
  );
}
