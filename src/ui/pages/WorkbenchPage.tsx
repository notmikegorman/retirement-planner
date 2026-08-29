/**
 * The Workbench — the app's primary page, and very nearly the whole app.
 *
 * Inputs and results live together: the knobs on the left, the results on the
 * right, and every committed change on the left re-runs the simulation and
 * updates the right. There is no save-then-navigate-then-run loop, because that
 * loop is what made "I wonder what happens if…" cost six clicks and a page
 * change.
 *
 * Three rules make the feedback trustworthy:
 *
 *  1. FIXED SEED. Interactive runs always use the same seed, so successive runs
 *     differ only because of the edit — never because Monte Carlo resampled.
 *     Changing the seed is possible, but deliberate (see ScenarioPanel).
 *  2. NEVER BLANK. A run in flight leaves the previous results on screen,
 *     dimmed, under a slim progress bar. Superseded runs are dropped by request
 *     id, so a slow run can never overwrite a newer one.
 *  3. ONE PLAN, ALWAYS SAVED. There is no working copy and no Save button: the
 *     same debounced signal that re-runs the simulation also PUTs plan.json, so
 *     re-opening the app always picks up exactly where it left off. What-ifs are
 *     explored by adding and removing events, and a before/after is made by
 *     pinning a baseline run in the results.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  FanChart,
  Profile,
  ProfileSettings,
  RunResult,
  Scenario,
  SocialSecurityData,
} from '../../shared/types';
import { api, pollRun } from '../api';
import { simulationReadiness } from '../firstRun';
import {
  RESULTS_TAB_IDS,
  RESULTS_TAB_STORAGE_KEY,
  resolveTab,
  writeStoredTab,
  type PageProps,
  type ResultsTabId,
} from '../nav';
import { useToast } from '../toast';
import { ScenarioPanel } from '../components/workbench/ScenarioPanel';
import { LiveResults, type PinnedBaseline } from '../components/workbench/LiveResults';
import {
  defaultRunSettings,
  finalRunParams,
  finalStandInParams,
  planSaveKey,
  refreshFailureNote,
  resolveRunParams,
  runInputKey,
  runMetrics,
  type ResolvedRunParams,
  type RunMetrics,
  type RunNowState,
  type RunSettings,
  type SaveState,
} from '../components/workbench/workbenchLogic';
import { validateScenario, type MarketDefaults } from '../components/scenarios/scenarioHelpers';
import {
  effectiveSuccessTarget,
  runResultCache,
  scenarioForPlainRun,
} from '../components/results/resultsData';

/**
 * How long after a committed change the run — and the save — fire. Long enough
 * to coalesce a burst of edits (tabbing through three spending fields), short
 * enough that a single change feels immediate: a 1,000-path run is ~300ms on
 * the user's profile, so the whole loop lands well inside a second.
 */
const LIVE_DEBOUNCE_MS = 400;

/**
 * What survives leaving the page. Navigating to the Dashboard and back would
 * otherwise blank the results until the live loop finished a fresh run and —
 * worse — silently drop a pinned baseline. The run itself comes from
 * runResultCache by id; only the comparison state lives here.
 *
 * `pendingSave` is the other half of the autosave contract: leaving the page
 * inside the debounce window flushes the plan on the way out, and the next load
 * waits for that write before reading the file back, so a fast navigate-and-
 * return can never resurrect the pre-edit plan. A failed flush leaves its
 * message in `saveError`, which the next mount shows — an autosave failure has
 * to survive the navigation that hid it.
 */
const session: {
  runId: string | null;
  previous: RunMetrics | null;
  baseline: PinnedBaseline | null;
  pendingSave: Promise<void> | null;
  saveError: string | null;
} = { runId: null, previous: null, baseline: null, pendingSave: null, saveError: null };

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Put a plan into the workbench from somewhere else in the app (the Search
 * page's "open this finalist"), safely.
 *
 * It exists for ONE hazard. Leaving the workbench inside the autosave debounce
 * leaves a PUT in flight (`session.pendingSave`); writing a different plan
 * without waiting for it could let the older write land second and quietly
 * resurrect the plan the user just left. Awaiting the pending flush first
 * makes the ordering total — the same guarantee `load()` relies on.
 *
 * Nothing here touches component state: the workbench is unmounted when this is
 * called, and its next mount reads the file back.
 */
export async function loadPlanIntoWorkbench(plan: Scenario): Promise<void> {
  if (session.pendingSave) {
    try {
      await session.pendingSave;
    } catch {
      // The flush recorded its own message; this write supersedes it anyway.
    }
    session.pendingSave = null;
  }
  await api.putPlan(plan);
  session.saveError = null;
  // The comparison state belongs to the plan that just left the screen: a
  // baseline pinned from a different plan would silently become the yardstick
  // for this one. The previous run's metrics stay, so the first delta reads as
  // "what loading this was worth", which is exactly what it is.
  session.baseline = null;
}

export function WorkbenchPage({ route, navigate, storedTab }: PageProps) {
  const { showToast } = useToast();

  /*
   * The results strip's tab is the URL's second segment (/workbench/cashflow).
   * It is resolved HERE, not in LiveResults, because this is the component the
   * route arrives at — LiveResults renders whichever tab it is handed. The
   * stored fallback only answers for a bare /workbench, and it is App's
   * app-load snapshot rather than a read of our own: resolveTab and
   * readStoredTab in nav.ts have the why for both halves.
   */
  const resultsTab = resolveTab(route.tab, RESULTS_TAB_IDS, storedTab);
  const selectResultsTab = (id: ResultsTabId) => {
    writeStoredTab(RESULTS_TAB_STORAGE_KEY, id);
    navigate('workbench', id);
  };

  // ---- loaded data -------------------------------------------------------
  const [profile, setProfile] = useState<Profile | null>(null);
  const [ssData, setSsData] = useState<SocialSecurityData | null>(null);
  const [marketDefaults, setMarketDefaults] = useState<MarketDefaults | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // ---- the plan ----------------------------------------------------------
  const [draft, setDraft] = useState<Scenario | null>(null);
  const [revision, setRevision] = useState(0);
  const [saveState, setSaveState] = useState<SaveState>(() =>
    session.saveError === null
      ? { status: 'idle' }
      : { status: 'error', message: session.saveError },
  );

  // ---- run settings + live run state ------------------------------------
  const [settings, setSettings] = useState<RunSettings | null>(null);
  const [result, setResult] = useState<RunResult | null>(() =>
    session.runId ? (runResultCache.get(session.runId) ?? null) : null,
  );
  const [previous, setPrevious] = useState<RunMetrics | null>(session.previous);
  const [baseline, setBaseline] = useState<PinnedBaseline | null>(session.baseline);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [runError, setRunError] = useState<string | null>(null);
  /** How far a Run now has got, so the button never looks like a dead click. */
  const [runNow, setRunNow] = useState<RunNowState>({ status: 'idle' });

  const alive = useRef(true);
  /** Monotonic id: only the newest request may write into state. */
  const requestId = useRef(0);
  /** Same, for saves: an overtaken PUT must not report on a newer one's file. */
  const saveId = useRef(0);
  /**
   * Writes are chained, never concurrent: two PUTs in flight at once could land
   * out of order and leave the OLDER plan on disk — the one failure autosave
   * must not have, since nothing would ever correct it.
   */
  const saveChain = useRef<Promise<void>>(Promise.resolve());
  /** Inputs the newest run was started for, so identical edits don't re-run. */
  const lastRunKey = useRef<string | null>(null);
  /** The plan as last written to disk, so an unchanged plan is never re-PUT. */
  const lastSavedKey = useRef<string | null>(null);
  /** The rendered result, readable from async code without stale closures. */
  const resultRef = useRef<RunResult | null>(result);
  /** The live draft, readable from the unmount flush without a stale closure. */
  const draftRef = useRef<Scenario | null>(null);

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // Keep the cross-navigation session in step with what is on screen.
  useEffect(() => {
    session.previous = previous;
  }, [previous]);
  useEffect(() => {
    session.baseline = baseline;
  }, [baseline]);

  // ---- loading -----------------------------------------------------------

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      // A flush from the last unmount may still be in flight; reading the file
      // before it lands would hand back the pre-edit plan and then save it.
      if (session.pendingSave) {
        try {
          await session.pendingSave;
        } catch {
          // The flush already recorded its own message in session.saveError.
        }
        session.pendingSave = null;
      }
      const [prof, plan] = await Promise.all([api.getProfile(), api.getPlan()]);
      if (!alive.current) return;
      setProfile(prof);
      setSettings((prev) => prev ?? defaultRunSettings(prof.settings));
      setDraft(plan);
      // The plan as loaded IS what is on disk: the first debounce must re-run
      // the simulation but must not write the file straight back.
      lastSavedKey.current = planSaveKey(plan);
      setRevision((r) => r + 1);

      try {
        const a = await api.getAssumptions();
        if (!alive.current) return;
        setMarketDefaults({
          stocks: a.market.deterministicReal.stocks,
          bonds: a.market.deterministicReal.bonds,
          bills: a.market.deterministicReal.bills,
          inflation: a.market.deterministicInflation,
          // Not an overrides field — the Housing tab uses it to say (and to
          // seed) the rate the house would grow at with no plan rate set.
          homeSpread: a.market.homeAppreciationRealSpread,
        });
        setSsData(a.socialSecurity);
      } catch {
        // Placeholders/previews unavailable; every editor still works.
      }
    } catch (err) {
      if (alive.current) setLoadError(errorText(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // ---- autosave ----------------------------------------------------------

  const savePlan = useCallback(async (plan: Scenario) => {
    const key = planSaveKey(plan);
    // Catch what the server would reject anyway, but say it here and now: with
    // no Save button there is nothing else to tell the user their edits stopped
    // reaching the disk.
    const invalid = validateScenario(plan);
    if (invalid) {
      setSaveState({ status: 'error', message: invalid });
      return;
    }
    const id = ++saveId.current;
    setSaveState({ status: 'saving' });
    const write = saveChain.current.then(() => api.putPlan(plan));
    saveChain.current = write.then(
      () => undefined,
      () => undefined,
    );
    try {
      await write;
      if (!alive.current || saveId.current !== id) return;
      lastSavedKey.current = key;
      session.saveError = null;
      setSaveState({ status: 'saved' });
    } catch (err) {
      if (!alive.current || saveId.current !== id) return;
      session.saveError = errorText(err);
      setSaveState({ status: 'error', message: errorText(err) });
    }
  }, []);

  /**
   * Leaving the page inside the debounce window must not lose the edit: fire
   * the write on the way out and leave the promise where the next load can wait
   * for it. Nothing here touches component state — this runs at unmount.
   */
  useEffect(
    () => () => {
      const plan = draftRef.current;
      if (!plan) return;
      if (lastSavedKey.current === planSaveKey(plan)) return;
      const invalid = validateScenario(plan);
      if (invalid !== null) {
        // Unreachable through the forms, but if it ever happens the reason has
        // to outlive the navigation that hid it — never a silent drop.
        session.saveError = invalid;
        return;
      }
      lastSavedKey.current = planSaveKey(plan);
      session.pendingSave = saveChain.current
        .then(() => api.putPlan(plan))
        .then(
          () => {
            session.saveError = null;
          },
          (err: unknown) => {
            session.saveError = errorText(err);
          },
        );
    },
    [],
  );

  // ---- the live run loop -------------------------------------------------

  /**
   * ZERO-START'S GATE (src/ui/firstRun.ts): with zero accounts there is
   * nothing to simulate, so no run may start — not the live loop, not Run
   * now, not a cached-run restore — and no simulated figure may render, not
   * even one computed earlier this session against accounts since deleted.
   * The results column gets the first-run state instead.
   */
  const firstRun = useMemo(
    () => profile !== null && simulationReadiness(profile).state === 'no-accounts',
    [profile],
  );

  const runParams = useMemo(
    () => (profile && settings ? resolveRunParams(settings, profile.settings) : null),
    [profile, settings],
  );

  /**
   * Identity of the run INPUTS. The effect below fires only when this string
   * changes, so a re-render (or a blur that re-committed the same value) never
   * costs a simulation.
   */
  const inputKey = useMemo(
    () => (draft && runParams ? runInputKey(scenarioForPlainRun(draft), runParams) : null),
    [draft, runParams],
  );

  /**
   * Put a finished result on screen — but only if this is still the newest
   * request.
   *
   * The one place that writes a run into the page, shared by every path that
   * produces one (a simulation, and a final run restored from the cache). A
   * second copy of "only the newest request may write" would be a second place
   * for a slow answer to overwrite a fresh one, which is rule 2 at the top of
   * this file and the reason the machinery exists at all.
   */
  const publishResult = useCallback((runId: string, next: RunResult, id: number) => {
    if (!alive.current || requestId.current !== id) return;
    if (resultRef.current) setPrevious(runMetrics(resultRef.current));
    resultRef.current = next;
    runResultCache.set(runId, next);
    session.runId = runId;
    setResult(next);
  }, []);

  /**
   * Simulate `plan` under `params` and, if this is still the newest request when
   * the answer lands, put it on screen. Throws when the run itself failed.
   *
   * Shared by the live loop and by Run now, because both must obey the same two
   * rules — never blank, and only the newest request may write — and a second
   * copy of that machinery would be a second place for a slow run to overwrite a
   * fresh one. What the two callers do NOT share is where a failure is reported;
   * they each catch their own.
   */
  const runPlan = useCallback(
    async (plan: Scenario, params: ResolvedRunParams, id: number) => {
      // Sent inline with any solver stripped: the workbench answers "will this
      // work?", and sweeps are opt-in through Explore.
      const { runId } = await api.startRun({ scenario: scenarioForPlainRun(plan), ...params });
      const done = await pollRun(runId, (p) => {
        if (alive.current && requestId.current === id) setProgress(p.progress);
      });
      // A newer request already superseded this run — drop it on the floor
      // rather than letting a slow answer overwrite a fresh one.
      if (!alive.current || requestId.current !== id) return;
      if (done.status !== 'done' || !done.result) throw new Error(done.error ?? 'Run failed');
      publishResult(runId, done.result, id);
    },
    [publishResult],
  );

  /**
   * SHOW THE FINAL RUN THE APP ALREADY HAS, IF IT HAS ONE. True when a cached
   * final result was found (and shown, or dropped as superseded), false when
   * the caller should go and compute the quick run instead.
   *
   * The complaint: run at final quality, get 94.2%, refresh the browser,
   * and the page reverts to a 1,000-path 93.1% — a different number for a plan
   * that did not change. The 10,000-path answer was never gone; it was in the
   * run cache on disk (~477 runs live there) and nothing ever asked for it.
   *
   * IT ASKS ABOUT THE WHOLE INPUT, NOT THE PLAN. Matching on the plan alone
   * would be wrong in the one way that matters most here: holdings balances are
   * derived from quote prices, so the same plan at Friday's close and at
   * Monday's open are two different runs, and reusing one for the other would
   * put a stale number on screen labelled as the current one. The server keys
   * the cache on profile + assumptions + plan + mode + paths + seed + engine
   * version, which is "the same inputs entirely" — so a hit is not merely close
   * to right, it is the number a fresh run would print.
   *
   * NOTHING IS STARTED BY ASKING. api.lookupCachedRun answers from the file or
   * says no; it never spawns a simulation. Using POST /api/run for the question
   * would have been the obvious shortcut and is exactly the bug — its miss
   * starts the run, so every page load without a cached answer would quietly
   * begin a 10,000-path simulation nobody asked for.
   *
   * A FAILED LOOKUP IS A MISS, not an error. This is an optimisation on top of
   * a loop that already works; the quick run behind it asks the same server the
   * same question and will report whatever is actually wrong (an unpriced
   * holding, say) in the one place run failures belong.
   */
  const restoreFinalRun = useCallback(
    async (plan: Scenario, settings: ProfileSettings, params: ResolvedRunParams, id: number) => {
      const standIn = finalStandInParams(params, settings);
      if (standIn === null) return false;
      let cached: RunResult | null;
      try {
        ({ result: cached } = await api.lookupCachedRun({
          scenario: scenarioForPlainRun(plan),
          ...standIn,
        }));
      } catch {
        return false;
      }
      if (cached === null) return false;
      // meta.runKey IS the cache key the server filed it under (finishRun
      // normalises it), so the page's own by-id cache stays in step with the
      // server's without a second identifier to keep aligned.
      publishResult(cached.meta.runKey, cached, id);
      return true;
    },
    [publishResult],
  );

  const startRun = useCallback(async () => {
    if (!draft || !profile || !runParams || firstRun) return;
    lastRunKey.current = runInputKey(scenarioForPlainRun(draft), runParams);
    const id = ++requestId.current;
    setRunning(true);
    setProgress(0);
    setRunError(null);
    try {
      // Look first, compute second. On a miss — the ordinary case straight
      // after an edit — this costs one localhost round trip against a 400ms
      // debounce, and the quick run below happens exactly as it always did.
      const restored = await restoreFinalRun(draft, profile.settings, runParams, id);
      if (!restored) await runPlan(draft, runParams, id);
    } catch (err) {
      if (alive.current && requestId.current === id) setRunError(errorText(err));
    } finally {
      if (alive.current && requestId.current === id) {
        setRunning(false);
        setProgress(0);
      }
    }
  }, [draft, profile, runParams, firstRun, restoreFinalRun, runPlan]);

  /**
   * RUN NOW: today's prices, then the plan under the conditions everything else
   * records under.
   *
   * Two things make the live loop's number incomparable with a recorded one, and
   * this fixes both in order. First, holdings balances are derived from
   * quotes.json, which nothing on this page refreshes — so a score computed at
   * breakfast is priced at yesterday's close however many times the loop re-runs
   * it. Second, the loop runs at mcPathsInteractive (1,000) for responsiveness
   * while the History tab and the net-worth ledger record at mcPathsFinal
   * (10,000) on the profile seed. A user hit both at once: 93.1% on screen,
   * 94.2% recorded, same plan, same day.
   *
   * The automatic interactive run is deliberately untouched — it is what keeps
   * the screen alive while knobs move. This is the deliberate, slow answer.
   */
  const startRunNow = useCallback(async () => {
    if (!draft || !profile || !runParams || firstRun) return;
    /*
     * The INTERACTIVE key, not the final one. The live-loop effect compares
     * `lastRunKey` against `inputKey`, which is built from the interactive
     * params; recording the 10,000-path key here would leave them unequal and
     * fire a 1,000-path run 400ms later that overwrote the run just made.
     */
    lastRunKey.current = runInputKey(scenarioForPlainRun(draft), runParams);
    const id = ++requestId.current;
    setRunning(true);
    setProgress(0);
    setRunError(null);
    setRunNow({ status: 'quotes' });
    let outcome: RunNowState = { status: 'idle' };
    try {
      // PRICES FIRST, ALWAYS. No symbols means every symbol any account holds.
      // A per-symbol failure comes back as data rather than an exception and is
      // survivable — the previous quote stays on file and the run prices that
      // holding at it — so it is reported beside the number instead of
      // abandoning a run the user is waiting on.
      const refreshed = await api.refreshQuotes();
      if (!alive.current || requestId.current !== id) return;
      const missed = refreshFailureNote(refreshed.results);
      if (missed !== null) outcome = { status: 'error', message: missed };
      setRunNow({ status: 'running' });
      await runPlan(draft, finalRunParams(profile.settings), id);
    } catch (err) {
      // Nothing above this line replaced the result, so the number on screen is
      // still the last good one — which is the point: a failed Run now must cost
      // the user the wait, never the answer he already had.
      outcome = { status: 'error', message: `Run now failed — ${errorText(err)}` };
    } finally {
      if (alive.current) {
        setRunNow(outcome);
        if (requestId.current === id) {
          setRunning(false);
          setProgress(0);
        }
      }
    }
  }, [draft, profile, runParams, firstRun, runPlan]);

  /**
   * ONE debounce, both effects. A change to the plan re-runs the simulation and
   * writes plan.json; a change to a run setting (mode, seed, paths) only
   * re-runs, because run settings are not part of the plan.
   */
  useEffect(() => {
    if (!draft || inputKey === null) return;
    const needsRun = lastRunKey.current !== inputKey;
    const needsSave = lastSavedKey.current !== planSaveKey(draft);
    if (!needsRun && !needsSave) return;
    const timer = setTimeout(() => {
      if (lastSavedKey.current !== planSaveKey(draft)) void savePlan(draft);
      if (lastRunKey.current !== inputKey) void startRun();
    }, LIVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [draft, inputKey, savePlan, startRun]);

  // ---- editing -----------------------------------------------------------

  const updateDraft = (patch: Partial<Scenario>) => {
    setDraft((d) => (d ? { ...d, ...patch } : d));
  };

  const replaceDraft = (plan: Scenario) => {
    setDraft(plan);
    setRevision((r) => r + 1);
  };

  /**
   * A stored version has been copied onto the plan (the History tab's Restore).
   *
   * IT DELIBERATELY DOES NOT MARK THE PLAN AS SAVED, even though the server
   * has just written exactly this to plan.json. Marking it would skip the next
   * PUT — and skipping it re-opens a race the chain otherwise closes: an
   * autosave fired inside the 400ms debounce can still be in flight when the
   * restore lands, and it carries the PRE-restore draft. If that write is the
   * last one to reach the file, plan.json holds the old plan while the screen
   * holds the restored one, `lastSavedKey` says everything is saved, and
   * nothing ever corrects it — the disagreement survives the reload.
   *
   * Letting the debounce fire one more PUT closes it: every write goes through
   * `saveChain`, so the restored plan is queued BEHIND the stale autosave and
   * is the one that ends up on disk however the two raced. The cost is a write
   * that usually changes nothing, and a no-op write is free by construction —
   * planStore compares against the file and files no history entry for one.
   */
  const restoredPlan = (plan: Scenario) => {
    replaceDraft(plan);
    // The pinned comparison baseline was pinned from the plan that just left
    // the screen; keeping it would silently make it the yardstick for a
    // different plan. Same rule as loadPlanIntoWorkbench.
    setBaseline(null);
  };

  // ---- baseline ----------------------------------------------------------

  const pinBaseline = () => {
    if (!result) return;
    setBaseline({
      label: `run ${result.meta.runKey.slice(0, 8)}`,
      metrics: runMetrics(result),
      fan: result.fan as FanChart,
    });
    showToast('Pinned — every change is now measured from this run');
  };

  const clearBaseline = () => {
    setBaseline(null);
    showToast('Baseline cleared — back to comparing with the previous run');
  };

  // ---- render ------------------------------------------------------------

  if (loadError) {
    return (
      <div>
        <h1>Workbench</h1>
        <div className="error-banner">
          {loadError}{' '}
          <button onClick={() => void load()} style={{ marginLeft: 8 }}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (!profile || !draft || !settings || !runParams) {
    return (
      <div>
        <h1>Workbench</h1>
        <div className="muted">Loading…</div>
      </div>
    );
  }

  const target = effectiveSuccessTarget(profile, draft);

  return (
    <div>
      {/*
        No page heading here. The nav highlights "Workbench" already, so a title
        repeating it — and a sentence explaining that edits save themselves —
        cost a band of vertical space on every run to say what the nav and the
        save indicator each say better. The two error/loading branches above
        keep their heading: they render without the nav's context being useful.
      */}
      {/*
        THE PANEL IS ALWAYS OPEN. It used to collapse to a 40px rail behind a ⌘B
        toggle, with the state stored under `fplan-workbench-panel`, and it
        carried an "Inputs" heading and a "Saved — every change writes itself to
        plan.json" line above the tabs. All of it is gone: the panel IS the left
        half of the Workbench, the rail answered no question, and the two lines
        of chrome above the tabs were what stopped the panel's tab strip lining
        up with the results strip opposite. Both strips are now the first child
        of their column, which is the whole alignment mechanism.
      */}
      <div className="wb-layout">
        <div className="wb-panel">
          <ScenarioPanel
            draft={draft}
            saveState={saveState}
            result={result}
            onRetrySave={() => void savePlan(draft)}
            profile={profile}
            ssData={ssData}
            marketDefaults={marketDefaults}
            revision={revision}
            runSettings={settings}
            onRunSettingsChange={setSettings}
            onChange={updateDraft}
            onReplace={replaceDraft}
            onPlanRestored={restoredPlan}
          />
        </div>

        <div className="wb-results">
          <LiveResults
            result={firstRun ? null : result}
            previous={previous}
            baseline={baseline}
            target={target}
            running={running}
            progress={progress}
            error={runError}
            onRetry={() => void startRun()}
            onPinBaseline={pinBaseline}
            onClearBaseline={clearBaseline}
            profile={profile}
            plan={draft}
            runParams={runParams}
            onRunNow={() => void startRunNow()}
            runNow={runNow}
            tab={resultsTab}
            onSelectTab={selectResultsTab}
            firstRun={firstRun}
            onOpenAccounts={() => navigate('profile', 'accounts')}
          />
        </div>
      </div>
    </div>
  );
}
