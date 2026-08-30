import { Fragment } from 'react';
import { PAGES, useRoute, type Page } from './nav';
import { useSwUpdate } from './pwa';
import { ThemeContext, useThemeController } from './theme';
import { ToastProvider } from './toast';
import { FolderControl } from './components/topbar/FolderControl';
import { MODULE_ICONS } from './modules/icons';
import { ModuleBanner } from './modules/ModuleBanner';
import { WorkbenchPage } from './pages/WorkbenchPage';
import { SearchPage } from './pages/SearchPage';
import { NetWorthPage } from './pages/NetWorthPage';
import { AccountsModule } from './modules/AccountsModule';
import { ExpensesModule } from './modules/ExpensesModule';
import { HealthModule } from './modules/HealthModule';
import { HomeModule } from './modules/HomeModule';
import { HouseholdModule } from './modules/HouseholdModule';
import { IncomeModule } from './modules/IncomeModule';
import { InsuranceModule } from './modules/InsuranceModule';
import { InvestingModule } from './modules/InvestingModule';
import { SettingsModule } from './modules/SettingsModule';
import { TithingModule } from './modules/TithingModule';

/**
 * THE SHELL (the owner's layout, 2026-08-30, modeled on smplmark): a narrow
 * left panel for navigating between modules, and a wide right panel holding
 * the selected module — each module opening with a banner where its title,
 * breadcrumbs and actions live. Plan sits FIRST above a separator (nav.ts's
 * PAGES carries the order — it is also the URL vocabulary), the rest run
 * alphabetical, and Settings lives at the very bottom, in the footer beside
 * the folder control. '/' still opens Plan.
 *
 * The labels live here as a Record over PAGES so a module added there
 * without a label (or a label without a module) fails to compile rather
 * than shipping a nameless sidebar item. 'workbench' is LABELLED Plan
 * (owner's rename, 2026-08-30); the id stays 'workbench' because it is also
 * the URL vocabulary and the storage-key namespace, and /plan would orphan
 * every existing link for a word.
 */
const NAV_LABELS: Record<Page, string> = {
  workbench: 'Plan',
  accounts: 'Accounts',
  expenses: 'Expenses',
  health: 'Health',
  home: 'Home',
  household: 'Household',
  income: 'Income',
  insurance: 'Insurance',
  investing: 'Investing',
  networth: 'Net worth',
  search: 'Search',
  settings: 'Settings',
  tithing: 'Tithing',
};

/**
 * Pages that stay in the URL vocabulary but draw no item in the MAIN sidebar
 * list. Search is parked (owner's call, 2026-08-30): the whole module —
 * page, server machinery, /search paths — keeps working for whoever types
 * the URL, but the sidebar stops advertising it; deleting it from this set
 * is the entire un-parking operation. Settings is not hidden at all — its
 * item renders in the sidebar FOOTER, at the very bottom.
 */
const NAV_HIDDEN: ReadonlySet<Page> = new Set(['search', 'settings']);

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
        <div className="appShell">
          <aside className="sideNav">
            <div className="sideNavBrand">Retirement Planner</div>
            <nav className="sideNavItems" aria-label="Modules">
              {PAGES.map((item) =>
                NAV_HIDDEN.has(item) ? null : (
                  <Fragment key={item}>
                    <button
                      className={page === item ? 'sideNavItem active' : 'sideNavItem'}
                      aria-current={page === item ? 'page' : undefined}
                      /*
                        No tab argument: arriving from another module names
                        none and lets that module's memory (or its table)
                        choose, and clicking the module you are already on
                        keeps the view you are reading — which makes the URL
                        identical, which makes it a replace, not a push.
                      */
                      onClick={() => navigate(item)}
                    >
                      <span className="sideNavIcon">{MODULE_ICONS[item]}</span>
                      {NAV_LABELS[item]}
                    </button>
                    {/* Plan stands alone above the working set. */}
                    {item === 'workbench' ? (
                      <div className="sideNavSep" aria-hidden="true" />
                    ) : null}
                  </Fragment>
                ),
              )}
            </nav>
            {/* Settings at the very bottom (owner's placement), then where
                the data on screen lives — File > New / File > Open. The
                theme control that used to sit here is a Settings field now. */}
            <div className="sideNavFooter">
              <button
                className={page === 'settings' ? 'sideNavItem active' : 'sideNavItem'}
                aria-current={page === 'settings' ? 'page' : undefined}
                onClick={() => navigate('settings')}
              >
                <span className="sideNavIcon">{MODULE_ICONS.settings}</span>
                {NAV_LABELS.settings}
              </button>
              <FolderControl />
            </div>
          </aside>
          <main className="moduleMain">
            {/*
              Workbench, Search and Net worth keep their existing page
              components whole (the Workbench deliberately so — the owner
              scoped it out of the module overhaul); the shell gives them the
              banner and the body wrapper the other modules render themselves.
              Every body is full-bleed now, so the old wide/narrow split is
              gone with the max-widths.
            */}
            {page === 'workbench' && (
              <>
                <ModuleBanner title="Plan" />
                <div className="moduleBody">
                  <WorkbenchPage {...props} />
                </div>
              </>
            )}
            {page === 'search' && (
              <>
                <ModuleBanner title="Search" />
                <div className="moduleBody">
                  <SearchPage {...props} />
                </div>
              </>
            )}
            {/* Net worth wears its own banner (snapshot action, tabs). */}
            {page === 'networth' && <NetWorthPage {...props} />}
            {page === 'accounts' && <AccountsModule {...props} />}
            {page === 'expenses' && <ExpensesModule />}
            {page === 'health' && <HealthModule />}
            {page === 'home' && <HomeModule />}
            {page === 'household' && <HouseholdModule />}
            {page === 'income' && <IncomeModule />}
            {page === 'insurance' && <InsuranceModule {...props} />}
            {page === 'investing' && <InvestingModule />}
            {page === 'settings' && <SettingsModule />}
            {page === 'tithing' && <TithingModule />}
          </main>
          <SwUpdateBar />
        </div>
      </ToastProvider>
    </ThemeContext.Provider>
  );
}
