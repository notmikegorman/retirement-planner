/**
 * SEARCH — take over the running of the simulations.
 *
 * WHY THIS IS A PAGE AND NOT A TAB IN THE WORKBENCH. The workbench's contract
 * is that everything on the right describes the plan on the left, re-run within
 * a second of every keystroke. A search breaks all three halves of that: it
 * runs for twenty minutes rather than 300ms, it describes hundreds of plans
 * that are NOT on screen, and its output is a wide document — a leaderboard, a
 * forest plot, an attribution table — that would be strangled in a column
 * sized for a fan chart. It is also the one thing in this app that keeps
 * working while you are somewhere else: the search runs behind the api seam —
 * server-side in HTTP mode (closing the tab does not stop it), in a dedicated
 * coordinator worker in local mode (leaving this PAGE does not stop it; the
 * tab is the process, so closing THAT does — the seam warns via beforeunload,
 * and a killed search's bookmark 404s honestly on reopen). Coming back
 * re-attaches to whatever survived. That is a page, not a panel.
 *
 * The two features meet in the plan's history: a finalist here can be KEPT
 * under a name, and the workbench's History tab restores it into the one plan.
 * That round trip is the loop the user asked for — a search is only worth
 * running if its answers survive the page they were computed on.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  Scenario,
  SearchBudget,
  SearchObjective,
  SearchProgress,
  SearchReport,
  SearchSummary,
} from '../../shared/types';
import { api, searchAvailability } from '../api';
import { SEARCH_FIRST_RUN, simulationReadiness } from '../firstRun';
import {
  SEARCH_TAB_IDS,
  SEARCH_TAB_STORAGE_KEY,
  resolveTab,
  writeStoredTab,
  type PageProps,
  type SearchTabId,
} from '../nav';
import { useToast } from '../toast';
import { SearchProgressView } from '../components/search/SearchProgressView';
import { SearchReportView } from '../components/search/SearchReportView';
import { SpaceEditor } from '../components/search/SpaceEditor';
import {
  compileSpace,
  defaultAxisDrafts,
  formatDuration,
  mergeStoredDrafts,
  presetSpec,
  sanitiseDrafts,
  shouldEnumerate,
  type AxisDraft,
  type BudgetPreset,
} from '../components/search/searchLogic';
import { loadPlanIntoWorkbench } from './WorkbenchPage';

const SPACE_STORAGE_KEY = 'fplan-search-space';

/** How often a running search is re-read. It reports stages, not frames. */
const POLL_MS = 1500;

/** Labels for SEARCH_TAB_IDS, which nav.ts owns because they are URL segments. */
const TAB_LABELS: Record<SearchTabId, string> = {
  space: 'The space',
  progress: 'Progress',
  report: 'Report',
  history: 'History',
};

/**
 * WHICH search is being watched. The search itself lives on the server, so this
 * is a bookmark, not state.
 *
 * It is written to localStorage as well as memory, and that is not belt and
 * braces — it is the only way to find a RUNNING search again. `/api/searches`
 * is built by reading the report files on disk, and a report is only written
 * when the search finishes, so an in-flight search appears in no list
 * anywhere: without this bookmark, reloading the page during a twenty-minute
 * run would lose it until it completed.
 */
const WATCH_STORAGE_KEY = 'fplan-search-watching';

const session: { searchId: string | null } = {
  searchId:
    typeof localStorage === 'undefined' ? null : localStorage.getItem(WATCH_STORAGE_KEY),
};

function rememberWatched(searchId: string | null): void {
  session.searchId = searchId;
  try {
    if (typeof localStorage === 'undefined') return;
    if (searchId === null) localStorage.removeItem(WATCH_STORAGE_KEY);
    else localStorage.setItem(WATCH_STORAGE_KEY, searchId);
  } catch {
    // Storage disabled: the bookmark lasts as long as the tab does.
  }
}

interface SpaceState {
  drafts: AxisDraft[];
  label: string;
  metric: SearchObjective['metric'];
  practicalFloorText: string;
  preset: BudgetPreset;
  overrides: Partial<SearchBudget>;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function SearchPage({ navigate, route, storedTab }: PageProps) {
  const { showToast } = useToast();

  const [plan, setPlan] = useState<Scenario | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [space, setSpace] = useState<SpaceState | null>(null);
  /**
   * ZERO-START'S GATE (src/ui/firstRun.ts): a search is thousands of
   * simulations, and with zero accounts each would simulate a household that
   * does not exist. The whole page degrades to the honest note — the same
   * shape as the capability branch below, because the claim is the same
   * kind: this page cannot do its job yet, and here is why.
   */
  const [firstRun, setFirstRun] = useState(false);
  /**
   * One line about what the load-time heal dropped from the stored space, or
   * null when it dropped nothing. The stored copy is rewritten at the same
   * moment, so this appears exactly once — the next load has nothing to heal.
   */
  const [healNote, setHealNote] = useState<string | null>(null);

  // Only answers for a bare /search, and it is App's snapshot rather than a
  // read of our own — resolveTab and readStoredTab in nav.ts say why.
  const tab = resolveTab(route.tab, SEARCH_TAB_IDS, storedTab);
  /*
   * `replace` for a switch the reader did not ask for. The one below — a search
   * finishing and showing its report — is the app moving on its own, and a
   * history entry for it would make Back walk through a view nobody chose.
   * `navigate` is stable, so this useCallback stays stable too and the
   * finished-search effect it feeds is not re-armed on every render.
   */
  const selectTab = useCallback(
    (id: SearchTabId, opts?: { replace?: boolean }) => {
      writeStoredTab(SEARCH_TAB_STORAGE_KEY, id);
      navigate('search', id, opts);
    },
    [navigate],
  );

  const [progress, setProgress] = useState<SearchProgress | null>(null);
  const [report, setReport] = useState<SearchReport | null>(null);
  const [starting, setStarting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [history, setHistory] = useState<SearchSummary[]>([]);

  const alive = useRef(true);
  /**
   * The id of the search THIS page started and is waiting to show the report
   * for. An id rather than a boolean, and the difference is a real bug: with a
   * boolean, starting a new search while the previous one's finished state was
   * still on screen let the old search's "it finished" effect consume the flag
   * and yank the view to the OLD report a second after the new search started.
   */
  const autoSwitchId = useRef<string | null>(null);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // ---- load the plan and the stored space --------------------------------

  useEffect(() => {
    void (async () => {
      try {
        const [loaded, profile] = await Promise.all([api.getPlan(), api.getProfile()]);
        if (!alive.current) return;
        setFirstRun(simulationReadiness(profile).state === 'no-accounts');
        setPlan(loaded);
        const defaults = defaultAxisDrafts(loaded);
        const stored =
          typeof localStorage === 'undefined' ? null : localStorage.getItem(SPACE_STORAGE_KEY);
        let restored: Partial<SpaceState> = {};
        try {
          restored = stored === null ? {} : (JSON.parse(stored) as Partial<SpaceState>);
        } catch {
          restored = {};
        }
        // Heal the stored space before it can act: a level the schema has
        // since rejected does not age out of localStorage on its own — it
        // resubmits the same doomed request on every run until it is dropped.
        const healed = sanitiseDrafts(
          mergeStoredDrafts(restored.drafts ? JSON.stringify(restored.drafts) : null, defaults),
        );
        const next: SpaceState = {
          drafts: healed.drafts,
          label: typeof restored.label === 'string' ? restored.label : '',
          metric: restored.metric === 'success' ? 'success' : 'sustainable_spend',
          practicalFloorText:
            typeof restored.practicalFloorText === 'string' ? restored.practicalFloorText : '',
          preset:
            restored.preset === 'quick' || restored.preset === 'thorough'
              ? restored.preset
              : 'standard',
          overrides: typeof restored.overrides === 'object' && restored.overrides !== null
            ? restored.overrides
            : {},
        };
        if (healed.changed) {
          // Rewrite the stored copy so the dead levels are gone for good and
          // the note below does not recur on the next load.
          try {
            if (typeof localStorage !== 'undefined') {
              localStorage.setItem(SPACE_STORAGE_KEY, JSON.stringify(next));
            }
          } catch {
            // Storage disabled: the healed space still runs, just unremembered.
          }
          setHealNote(healed.notes.join(' '));
        }
        setSpace(next);
      } catch (err) {
        if (alive.current) setLoadError(errorText(err));
      }
    })();
  }, []);

  const updateSpace = (patch: Partial<SpaceState>) => {
    setSpace((s) => {
      if (!s) return s;
      const next = { ...s, ...patch };
      try {
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem(SPACE_STORAGE_KEY, JSON.stringify(next));
        }
      } catch {
        // Storage disabled: the space is still editable, just not remembered.
      }
      return next;
    });
  };

  // ---- attach to a search -------------------------------------------------

  const refreshHistory = useCallback(async () => {
    try {
      const list = await api.listSearches();
      if (alive.current) setHistory(list);
    } catch {
      // The history list is a convenience; a failure must not take the page down.
    }
  }, []);

  const watch = useCallback(async (searchId: string): Promise<boolean> => {
    rememberWatched(searchId);
    try {
      const p = await api.getSearch(searchId);
      if (!alive.current) return true;
      setProgress(p);
      if (p.report) setReport(p.report);
      else if (p.status === 'done' || p.status === 'cancelled') {
        try {
          setReport(await api.getSearchReport(searchId));
        } catch {
          // A search that failed before writing a report has none; the progress
          // view carries the error.
        }
      }
      return true;
    } catch {
      // The bookmark points at a search this server has never heard of —
      // restarted process, deleted report. Forget it rather than showing an
      // error for something the user did not ask for.
      rememberWatched(null);
      return false;
    }
  }, []);

  // On arrival: re-attach to the bookmarked search — which is the ONLY way to
  // find one that is still running — and fall back to the newest finished one.
  useEffect(() => {
    void (async () => {
      await refreshHistory();
      if (session.searchId && (await watch(session.searchId))) return;
      if (!alive.current) return;
      try {
        const list = await api.listSearches();
        const newest = list[0];
        if (newest && alive.current) await watch(newest.searchId);
      } catch {
        // No searches yet, or the server is down; the Space tab still works.
      }
    })();
  }, [refreshHistory, watch]);

  // ---- polling ------------------------------------------------------------

  const status = progress?.status;
  const watchedId = progress?.searchId;

  useEffect(() => {
    if (!watchedId) return;
    if (status !== 'running' && status !== 'queued') return;
    const timer = setInterval(() => {
      void (async () => {
        try {
          const p = await api.getSearch(watchedId);
          if (!alive.current) return;
          setProgress(p);
          if (p.report) setReport(p.report);
        } catch {
          // A transient failure must not kill the poll; the next tick retries.
        }
      })();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [watchedId, status]);

  // A search that finishes while being watched pulls its report and, if the
  // owner is sitting on the progress tab, shows it. It never steals the view
  // from someone reading something else.
  useEffect(() => {
    if (!watchedId) return;
    if (status !== 'done' && status !== 'cancelled') return;
    void (async () => {
      if (!report || report.searchId !== watchedId) {
        try {
          const r = await api.getSearchReport(watchedId);
          if (alive.current) setReport(r);
        } catch {
          // No report (an error before the report stage); progress says why.
        }
      }
      if (autoSwitchId.current === watchedId) {
        autoSwitchId.current = null;
        selectTab('report', { replace: true });
      }
      void refreshHistory();
    })();
  }, [watchedId, status, report, selectTab, refreshHistory]);

  // ---- actions ------------------------------------------------------------

  const start = async () => {
    if (!plan || !space) return;
    const compiled = compileSpace(space.drafts);
    if (compiled.axes.length === 0) {
      setStartError('Turn on at least one dimension first.');
      return;
    }
    setStarting(true);
    setStartError(null);
    // Drop the finished search off the page BEFORE starting: leaving a
    // done-status progress on screen leaves its "it finished" effect armed, and
    // it will happily re-fetch and show that older report over the new run.
    setProgress(null);
    setReport(null);
    try {
      const budget: Partial<SearchBudget> = {
        ...presetSpec(space.preset).budget,
        ...space.overrides,
      };
      budget.enumerate = shouldEnumerate(compiled.combinations, budget.candidates ?? 512);
      const floor = Number(space.practicalFloorText.trim());
      const objective: Partial<SearchObjective> = {
        metric: space.metric,
        ...(space.practicalFloorText.trim() !== '' && Number.isFinite(floor) && floor >= 0
          ? {
              // The floor is entered in the metric's own units: dollars a year,
              // or percentage POINTS (which the contract carries as a fraction).
              practicalFloor: space.metric === 'sustainable_spend' ? floor : floor / 100,
            }
          : {}),
      };
      const { searchId } = await api.startSearch({
        base: plan,
        axes: compiled.axes,
        objective,
        budget,
        ...(space.label.trim() === '' ? {} : { label: space.label.trim() }),
      });
      autoSwitchId.current = searchId;
      await watch(searchId);
      selectTab('progress');
      showToast('Search started — it keeps running if you leave this page');
      void refreshHistory();
    } catch (err) {
      setStartError(errorText(err));
    } finally {
      if (alive.current) setStarting(false);
    }
  };

  const cancel = async () => {
    if (!watchedId) return;
    setCancelling(true);
    try {
      const res = await api.cancelSearch(watchedId);
      showToast(
        res.stopping
          ? 'Stopping — the partial report will be written with the precision it reached'
          : 'That search is not running',
      );
      await watch(watchedId);
    } catch (err) {
      setStartError(errorText(err));
    } finally {
      if (alive.current) setCancelling(false);
    }
  };

  const openInWorkbench = async (scenario: Scenario) => {
    try {
      await loadPlanIntoWorkbench(scenario);
      showToast('Loaded into the workbench');
      navigate('workbench');
    } catch (err) {
      setStartError(errorText(err));
    }
  };

  // ---- render -------------------------------------------------------------

  /*
   * A backend without search gets the honest page, not a page that spins: the
   * capability is DECLARED by the seam (api.searchAvailability), so this
   * component never asks which backend it is on — and when search lands in
   * the browser (Phase 5), the declaration flips and this branch dies without
   * this file changing again.
   */
  if (!searchAvailability.available) {
    return (
      <div>
        <h1>Search</h1>
        <div className="muted" style={{ maxWidth: '44rem' }}>
          {searchAvailability.reason}
        </div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div>
        <h1>Search</h1>
        <div className="error-banner">{loadError}</div>
      </div>
    );
  }

  if (firstRun) {
    return (
      <div>
        <h1>Search</h1>
        <div className="muted" style={{ maxWidth: '44rem' }}>
          {SEARCH_FIRST_RUN}
        </div>
      </div>
    );
  }

  if (!plan || !space) {
    return (
      <div>
        <h1>Search</h1>
        <div className="muted">Loading…</div>
      </div>
    );
  }

  const running = status === 'running' || status === 'queued';

  return (
    <div>
      <div className="row" style={{ marginBottom: 12 }}>
        <h1 style={{ margin: 0 }}>Search</h1>
        <span className="spacer" />
        {progress && (
          <span className="muted">
            {running ? (
              <>
                <span className="wb-dot dirty" aria-hidden="true" /> {progress.stageLabel || progress.stage} ·{' '}
                {formatDuration(progress.elapsedMs)}
              </>
            ) : (
              `last search: ${progress.status}`
            )}
          </span>
        )}
      </div>

      <div className="tabs" role="tablist" aria-label="Search views">
        {SEARCH_TAB_IDS.map((id) => (
          <button
            key={id}
            role="tab"
            id={`search-tab-${id}`}
            aria-selected={tab === id}
            aria-controls={`search-panel-${id}`}
            className={tab === id ? 'tab is-active' : 'tab'}
            onClick={() => selectTab(id)}
          >
            {TAB_LABELS[id]}
            {id === 'progress' && running ? ' •' : ''}
          </button>
        ))}
      </div>

      <div role="tabpanel" id={`search-panel-${tab}`} aria-labelledby={`search-tab-${tab}`}>
        {tab === 'space' && healNote && (
          // One muted line, not a modal: the heal already happened and needs
          // no decision from the user — only an honest account of it.
          <div className="muted" style={{ marginBottom: 10 }}>
            {healNote}
          </div>
        )}
        {tab === 'space' && (
          <SpaceEditor
            drafts={space.drafts}
            onDraftsChange={(drafts) => updateSpace({ drafts })}
            label={space.label}
            onLabelChange={(label) => updateSpace({ label })}
            metric={space.metric}
            onMetricChange={(metric) => updateSpace({ metric })}
            practicalFloorText={space.practicalFloorText}
            onPracticalFloorChange={(practicalFloorText) => updateSpace({ practicalFloorText })}
            preset={space.preset}
            onPresetChange={(preset) => updateSpace({ preset })}
            overrides={space.overrides}
            onOverridesChange={(overrides) => updateSpace({ overrides })}
            onStart={() => void start()}
            starting={starting}
            busyElsewhere={running}
            error={startError}
          />
        )}

        {tab === 'progress' &&
          (progress ? (
            <SearchProgressView
              progress={progress}
              onCancel={() => void cancel()}
              cancelling={cancelling}
            />
          ) : (
            <div className="card muted">
              Nothing running. Define a space on the first tab and start a search.
            </div>
          ))}

        {tab === 'report' &&
          (report ? (
            <SearchReportView report={report} onOpenInWorkbench={openInWorkbench} />
          ) : (
            <div className="card muted">
              {running
                ? 'The report is written when the search finishes — including when you stop it early.'
                : 'No report yet. Run a search, or open one from the History tab.'}
            </div>
          ))}

        {tab === 'history' && (
          <HistoryList
            history={history}
            currentId={watchedId ?? null}
            onOpen={(id) => {
              void (async () => {
                setReport(null);
                await watch(id);
                selectTab('report');
              })();
            }}
            onRefresh={() => void refreshHistory()}
          />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

function HistoryList({
  history,
  currentId,
  onOpen,
  onRefresh,
}: {
  history: SearchSummary[];
  currentId: string | null;
  onOpen: (searchId: string) => void;
  onRefresh: () => void;
}) {
  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 8 }}>
        <h2 style={{ margin: 0 }}>Searches run</h2>
        <span className="spacer" />
        <button className="link-button" onClick={onRefresh}>
          Refresh
        </button>
      </div>

      {history.length === 0 ? (
        <div className="muted">No searches yet.</div>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Search</th>
                <th>Dimensions</th>
                <th>Plans</th>
                <th>Winner</th>
                <th>Took</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {history.map((h) => (
                <tr key={h.searchId} className={h.searchId === currentId ? 'best-row' : undefined}>
                  <td>
                    {h.label ?? h.searchId.slice(0, 8)}
                    {h.truncated && (
                      <>
                        {' '}
                        <span className="flag" title="Stopped early — a partial answer">
                          partial
                        </span>
                      </>
                    )}
                    <div className="muted">{new Date(h.createdAt).toLocaleString('en-US')}</div>
                  </td>
                  <td>{h.dims.length}</td>
                  <td>{h.candidatesGenerated.toLocaleString('en-US')}</td>
                  <td style={{ whiteSpace: 'normal', maxWidth: 380 }}>{h.winnerLabel ?? '—'}</td>
                  <td>{formatDuration(h.elapsedMs)}</td>
                  <td>
                    <button onClick={() => onOpen(h.searchId)}>Open</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="muted" style={{ marginTop: 8 }}>
        Reports are kept on disk, so an older one can be reopened and re-read at any time — and
        two searches of the same space carry the same space hash, which is what makes them
        comparable.
      </div>
    </div>
  );
}
