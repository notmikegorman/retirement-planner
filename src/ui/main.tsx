import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { api, backendMode, ensureBackendReady } from './api';
import './styles.css';

/**
 * The app's programmable seam, the browser-mode descendant of `curl
 * localhost:5599/api/...`: the routes retire with the server (browser-port
 * plan §5), and this is what replaces "scriptable" — one object, both
 * backends, same shapes. The dual-stack gate drives it to assert the refusals
 * the UI deliberately draws no button for (a second score on a scored row).
 */
declare global {
  interface Window {
    __fplanApi: typeof api;
  }
}
window.__fplanApi = api;

const root = createRoot(document.getElementById('root')!);

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

/**
 * BOOT ORDER, local mode: the backend (folder → writer guard → seed/migrate)
 * comes up before the first component renders, so every page mounts against a
 * guarded, migrated folder — the same position initDataDir holds behind the
 * server's listen(). HTTP mode resolves immediately and renders exactly as it
 * always has.
 */
async function boot(): Promise<void> {
  if (backendMode === 'local') {
    try {
      await ensureBackendReady();
    } catch (err) {
      root.render(
        <React.StrictMode>
          <GuardRefusal message={err instanceof Error ? err.message : String(err)} />
        </React.StrictMode>,
      );
      return;
    }
  }
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

void boot();
