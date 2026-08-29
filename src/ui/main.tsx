import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { api, backendMode, ensureBackendReady } from './api';
import { DemoStorageBanner, FolderReconnect, StorageChooser } from './local/StorageGate';
import {
  clearStorageChoice,
  computeBootGate,
  forgetFolderHandle,
  loadFolderHandle,
} from './local/storageChoice';
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
 * BOOT ORDER, local mode: the storage gate first (where should the data
 * live? — rendered as a page whenever the answer needs a user gesture:
 * first-visit choice, folder re-grant), then the backend (folder → writer
 * guard → seed/migrate) before the first component renders, so every page
 * mounts against a guarded, migrated folder — the same position initDataDir
 * holds behind the server's listen(). HTTP mode resolves immediately and
 * renders exactly as it always has.
 */
async function boot(): Promise<void> {
  let demoStorage = false;
  if (backendMode === 'local') {
    const gate = await computeBootGate();
    if (gate.kind === 'choose') {
      render(<StorageChooser canPickFolder={gate.canPickFolder} onChosen={() => void boot()} />);
      return;
    }
    if (gate.kind === 'reconnect') {
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
    try {
      await ensureBackendReady();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
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
  render(
    <>
      {demoStorage ? <DemoStorageBanner /> : null}
      <App />
    </>,
  );
}

void boot();
