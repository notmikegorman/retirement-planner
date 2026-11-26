import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { api, backendMode, ensureBackendReady } from './api';
import { bootTrace, traceFinished, traceStep } from './bootTrace';
import { maybeRegisterServiceWorker } from './pwa';
import { DemoStorageBanner, FolderReconnect, ProfileSetup, StorageChooser } from './local/StorageGate';
import {
  clearStorageChoice,
  computeBootGate,
  forgetFolderHandle,
  loadFolderHandle,
  profileSetupNeeded,
} from './local/storageChoice';
import {
  NETWORTH_TAB_STORAGE_KEY,
  RESULTS_TAB_STORAGE_KEY,
  SEARCH_TAB_STORAGE_KEY,
  appBase,
  withBase,
} from './nav';
import './styles.css';

/**
 * The app's programmable seam, the browser-mode descendant of `curl
 * localhost:5599/api/...`: the routes retire with the server (browser-port
 * plan §5), and this is what replaces "scriptable" — one object, both
 * backends, same shapes. A DELIBERATE surface, documented in DEVELOPMENT.md
 * ("Scripting the app"): the walkthrough and dual-stack gates drive it to
 * assert the refusals the UI deliberately draws no button for (a second
 * score on a scored row), and the owner can too, from the console.
 */
declare global {
  interface Window {
    __fplanApi: typeof api;
  }
}
window.__fplanApi = api;

// The PWA service worker — a no-op in every build except the Pages deploy's
// (VITE_FPLAN_SW=1); src/ui/pwa.ts carries the update discipline.
maybeRegisterServiceWorker();

const root = createRoot(document.getElementById('root')!);

function render(node: React.ReactNode): void {
  root.render(<React.StrictMode>{node}</React.StrictMode>);
}

/**
 * A writer-guard refusal, rendered as the whole page. Only local mode can
 * produce one (the guard is the folder's front door — src/ui/local/
 * localBackend.ts boots it before any store touches a byte), and it must be a
 * page rather than a toast: there is no app to show behind it, because
 * showing one would mean reading a folder another writer holds. The message
 * is the guard's own — what has the folder, where, what to do now — and Retry
 * re-attempts the boot, which succeeds the moment the other writer is gone.
 */
function GuardRefusal({ message }: { message: string }) {
  return (
    <div style={{ maxWidth: '44rem', margin: '4rem auto', padding: '0 1rem' }}>
      <h1>This data folder already has a writer</h1>
      <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', lineHeight: 1.5 }}>
        {message}
      </pre>
      <button className="primary" onClick={() => void boot()}>
        Retry
      </button>
    </div>
  );
}

/** Any other local-boot failure: same shape, honest heading, same Retry. */
function BootFailure({ message }: { message: string }) {
  return (
    <div style={{ maxWidth: '44rem', margin: '4rem auto', padding: '0 1rem' }}>
      <h1>The app could not open your data</h1>
      <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', lineHeight: 1.5 }}>
        {message}
      </pre>
      <button className="primary" onClick={() => void boot()}>
        Retry
      </button>
    </div>
  );
}

/** How long a boot may run before the page says where it is stuck. */
const BOOT_STUCK_MS = 10_000;

/**
 * Throw away the cached copy of the app — service worker and its caches —
 * and reload from the network. The data is untouched: it lives in the folder
 * (or browser storage), never in these caches.
 */
async function resetAppCache(): Promise<void> {
  try {
    const regs = (await navigator.serviceWorker?.getRegistrations()) ?? [];
    await Promise.all(regs.map((r) => r.unregister()));
    const keys = (await globalThis.caches?.keys()) ?? [];
    await Promise.all(keys.map((k) => caches.delete(k)));
  } finally {
    location.reload();
  }
}

/**
 * The first screen, shown the moment the bundle runs: blank for a beat (a
 * normal boot replaces it before anyone sees it), then "Starting…", then —
 * once the boot has run BOOT_STUCK_MS — the step it is waiting on, every step
 * so far, and what this browser is, so a report from a machine nobody else
 * can touch carries its own diagnosis (bootTrace.ts says why).
 */
function BootStatus() {
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(timer);
  }, []);
  const elapsed = Math.round(performance.now());
  if (elapsed < 1500) return null;
  const { steps } = bootTrace();
  const current = steps[steps.length - 1];
  const stuck = elapsed >= BOOT_STUCK_MS;
  return (
    <div style={{ maxWidth: '44rem', margin: '4rem auto', padding: '0 1rem' }} role="status">
      <h1>{stuck ? 'Startup is taking too long' : 'Starting…'}</h1>
      {stuck ? (
        <>
          <p>
            Waiting on: <strong>{current?.label ?? 'the app’s code to start'}</strong> (for{' '}
            {Math.round((elapsed - (current?.at ?? 0)) / 1000)}s)
          </p>
          <pre className="bootTrace" style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>
            {[
              ...steps.map((st) => `+${st.at}ms  ${st.label}`),
              '',
              `browser: ${navigator.userAgent}`,
              `service worker: ${navigator.serviceWorker?.controller ? 'controlling this page' : 'none'}`,
              `address: ${location.pathname}${location.search}`,
            ].join('\n')}
          </pre>
          <p>
            If the data folder is in iCloud Drive, macOS may be downloading its files; open the
            folder in Finder to check. Otherwise, try:
          </p>
          <p style={{ display: 'flex', gap: 8 }}>
            <button className="primary" onClick={() => location.reload()}>
              Reload
            </button>
            <button onClick={() => void resetAppCache()}>Clear the app cache and reload</button>
          </p>
        </>
      ) : (
        <p className="muted">{current?.label}</p>
      )}
    </div>
  );
}

/** Reconnect's permission re-grant — must run inside the button's gesture. */
async function requestFolderAccess(): Promise<boolean> {
  const saved = await loadFolderHandle();
  if (saved === null) return false;
  const state = (await saved.handle.requestPermission?.({ mode: 'readwrite' })) ?? 'granted';
  return state === 'granted';
}

/** Reconnect's escape hatch: forget the folder, ask THE question again. */
async function chooseOtherStorage(): Promise<void> {
  clearStorageChoice();
  await forgetFolderHandle();
  await boot();
}

/**
 * A completed setup form is a FRESH START, and a fresh start must not inherit
 * the previous household's reading position. The remembered-tab keys are
 * per-browser, not per-folder, and setup completes without a page reload — so
 * without this, File > New into an empty folder opens the Workbench on
 * whatever input tab the OLD plan was last touching (the owner hit exactly
 * that: a brand-new plan opening on Housing instead of Plan). Dropping the
 * keys lets every strip fall back to its first tab; the URL is reset to the
 * bare Plan page for the same reason, since a leftover /workbench/cashflow —
 * or a path from a page that no longer exists — is also the old folder's
 * position. Plan, not the root: the root is the Dashboard (2026-11-21), and a
 * household that has just been typed in has no score to show there — Plan is
 * where it learns what is missing.
 * <App/> has not mounted yet on this path, so its one storage snapshot reads
 * the cleared state.
 */
function resetRememberedViews(): void {
  const keys = [
    RESULTS_TAB_STORAGE_KEY,
    SEARCH_TAB_STORAGE_KEY,
    NETWORTH_TAB_STORAGE_KEY,
    // The Plan input panel's keys — file-local in ScenarioPanel.tsx
    // (PANEL_OPEN_STORAGE_KEY and its tab-era seed PANEL_TAB_LEGACY_KEY),
    // repeated here rather than exported because tests/ui/tithingTab.test.ts
    // pins those declaration lines verbatim. Both must go: a surviving
    // legacy key would re-seed the open set with the old household's
    // reading position.
    'fplan-inputs-open',
    'fplan-inputs-tab',
  ];
  try {
    for (const key of keys) localStorage.removeItem(key);
  } catch {
    // Storage disabled: the stale-tab hazard cannot exist without storage.
  }
  const plan = withBase('/workbench', appBase());
  if (window.location.pathname !== plan) window.history.replaceState(null, '', plan);
}

/**
 * BOOT ORDER, local mode: the storage gate first (where should the data
 * live? — rendered as a page whenever the answer needs a user gesture:
 * first-visit choice, folder re-grant), then the backend (folder → writer
 * guard → seed/migrate) before the first component renders, so every page
 * mounts against a guarded, migrated folder — the same position initDataDir
 * holds behind the server's listen(). Then the gate's SECOND stage
 * (zero-start): a folder holding no profile gets the setup step before the
 * app — the boot no longer invents a household to skip the question
 * (profileSetupNeeded in storageChoice.ts carries the rule; the D8 demo
 * seeds its example and never lands here). HTTP mode resolves immediately
 * and renders exactly as it always has.
 */
async function boot(): Promise<void> {
  let demoStorage = false;
  if (backendMode === 'local') {
    const gate = await computeBootGate();
    if (gate.kind === 'choose') {
      traceFinished('the storage chooser');
      render(<StorageChooser canPickFolder={gate.canPickFolder} onChosen={() => void boot()} />);
      return;
    }
    if (gate.kind === 'reconnect') {
      traceFinished('the folder reconnect');
      render(
        <FolderReconnect
          folderName={gate.folderName}
          requestAccess={requestFolderAccess}
          onReady={() => void boot()}
          onChooseOther={() => void chooseOtherStorage()}
        />,
      );
      return;
    }
    demoStorage = gate.kind === 'ready-opfs' && gate.demo;
    const friendMode = gate.kind === 'ready-friend';
    try {
      traceStep('starting the local backend');
      await ensureBackendReady();
      traceStep('asking whether the folder holds a household');
      // The second stage: storage is ready, the guard is held — does the
      // folder hold a household? meta() answers LIVE, so the re-boot after
      // the setup write falls straight through here.
      const meta = await api.meta();
      if (
        profileSetupNeeded({
          demo: demoStorage,
          profileExists: meta.profileExists !== false,
          friendMode,
        })
      ) {
        traceFinished('the household setup');
        render(
          <ProfileSetup
            onSubmit={async (profile) => {
              // The ordinary store path: validated by the same schema as any
              // other profile write, behind the writer guard already held.
              await api.putProfile(profile);
              // Only after the write: a failed submit re-renders the form and
              // must not have thrown away the current household's tabs.
              resetRememberedViews();
              await boot();
            }}
          />,
        );
        return;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      traceFinished(`the boot failure: ${message}`);
      // The guard refusal keeps its own page (its heading IS the diagnosis);
      // everything else gets the honest generic one. Matched by name rather
      // than instanceof so main.tsx never statically imports the local
      // backend chunk that api.ts deliberately loads lazily.
      render(
        err instanceof Error && err.name === 'LocalBootRefusedError' ? (
          <GuardRefusal message={message} />
        ) : (
          <BootFailure message={message} />
        ),
      );
      return;
    }
  }
  traceFinished('the app');
  render(
    <>
      {demoStorage ? <DemoStorageBanner /> : null}
      <App />
    </>,
  );
}

// An error nobody caught during boot would otherwise leave the BootStatus
// screen waiting for ever; put it on screen instead, and in the console.
window.addEventListener('error', (e) => {
  if (!bootTrace().finished) render(<BootFailure message={`Startup error: ${e.message}`} />);
});
window.addEventListener('unhandledrejection', (e) => {
  const reason = e.reason instanceof Error ? e.reason.message : String(e.reason);
  if (!bootTrace().finished) render(<BootFailure message={`Startup error: ${reason}`} />);
});

(window as unknown as { __fplanBooting?: boolean }).__fplanBooting = true;
traceStep('the app’s code is running');
render(<BootStatus />);
void boot();
