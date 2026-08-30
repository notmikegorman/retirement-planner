import { PAGES, useRoute, type Page } from './nav';
import { useSwUpdate } from './pwa';
import { ThemeContext, themeModeIcon, themeModeLabel, useThemeController } from './theme';
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
 * breadcrumbs and actions live. The old Profile page's ten tabs are modules
 * now, beside Workbench and Net worth, and the sidebar lists them
 * ALPHABETIZED (nav.ts's PAGES carries the order — it is also the URL
 * vocabulary). '/' still opens the Workbench.
 *
 * The labels live here as a Record over PAGES so a module added there
 * without a label (or a label without a module) fails to compile rather
 * than shipping a nameless sidebar item.
 */
const NAV_LABELS: Record<Page, string> = {
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
  workbench: 'Workbench',
};

/**
 * Pages that stay in the URL vocabulary but draw no sidebar item. Search is
 * parked here (owner's call, 2026-08-30): the whole module — page, server
 * machinery, /search paths — keeps working for whoever types the URL, but the
 * sidebar stops advertising it. Deleting it from this set is the entire
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
        <div className="appShell">
          <aside className="sideNav">
            <div className="sideNavBrand">Retirement Planner</div>
            <nav className="sideNavItems" aria-label="Modules">
              {PAGES.map((item) =>
                NAV_HIDDEN.has(item) ? null : (
                  <button
                    key={item}
                    className={page === item ? 'sideNavItem active' : 'sideNavItem'}
                    aria-current={page === item ? 'page' : undefined}
                    /*
                      No tab argument: arriving from another module names none
                      and lets that module's memory (or its table) choose, and
                      clicking the module you are already on keeps the view
                      you are reading — which makes the URL identical, which
                      makes it a replace, not a push.
                    */
                    onClick={() => navigate(item)}
                  >
                    <span className="sideNavIcon">{MODULE_ICONS[item]}</span>
                    {NAV_LABELS[item]}
                  </button>
                ),
              )}
            </nav>
            {/* Where the data on screen lives, and the door to anywhere else
                it could (File > New / File > Open) — plus the theme control:
                the shell's own facts, kept out of every module's banner. */}
            <div className="sideNavFooter">
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
            </div>
          </aside>
          <main className="moduleMain">
            {/*
              Workbench, Search and Net worth keep their existing page
              components whole (the Workbench deliberately so — the owner
              scoped it out of the module overhaul); the shell gives them the
              banner and the body wrapper the other modules render themselves.
              The Workbench's two columns and the search report's wide
              document both get the wider body.
            */}
            {page === 'workbench' && (
              <>
                <ModuleBanner title="Workbench" />
                <div className="moduleBody wide">
                  <WorkbenchPage {...props} />
                </div>
              </>
            )}
            {page === 'search' && (
              <>
                <ModuleBanner title="Search" />
                <div className="moduleBody wide">
                  <SearchPage {...props} />
                </div>
              </>
            )}
            {page === 'networth' && (
              <>
                <ModuleBanner title="Net worth" />
                <div className="moduleBody">
                  <NetWorthPage {...props} />
                </div>
              </>
            )}
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
