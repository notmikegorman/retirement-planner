/**
 * The data-folder card — where the bytes live, what they cost, and the door
 * to living somewhere else. Moved verbatim from the retired Dashboard page
 * (2026-08-30) to Profile > Settings, because settings is where you go to ask
 * "where is my stuff?" and the rest of the Dashboard was a read-only echo of
 * pages that already exist.
 *
 * Three obligations follow it here:
 *  - Decision D7's bargain: the runs/ cache is unbounded, and in exchange its
 *    size is SHOWN — this card is the showing.
 *  - The storage-persistence answer (navigator.storage.persisted) surfaces
 *    quietly here, beside the engine version.
 *  - "Switch storage…" (local mode) is the one affordance that re-asks THE
 *    question; the folder menu's OPFS note points at this card by name.
 */
import { useCallback, useEffect, useState } from 'react';
import { api, backendMode, type ServerMeta } from '../../api';
import { clearStorageChoice, forgetFolderHandle } from '../../local/storageChoice';

/** "1.2 MB", "348 KB" — for the run-cache row; no i18n, matching formatUSD. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The change-folder affordance (Phase-7 boot flow): forget the storage
 * choice and the stored folder handle, then reload into the chooser. It
 * deletes NOTHING — the folder and every file in it stay exactly where they
 * are; the OPFS world likewise — which is why the button needs no confirm.
 */
async function switchStorage(): Promise<void> {
  clearStorageChoice();
  await forgetFolderHandle();
  location.reload();
}

export function DataFolderCard() {
  const [meta, setMeta] = useState<ServerMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** navigator.storage.persisted() — the quiet surface for the one-time
      persistence request the boot flow made; null while unknown/N-A. */
  const [persisted, setPersisted] = useState<boolean | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setMeta(await api.meta());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
    if (backendMode === 'local' && typeof navigator.storage?.persisted === 'function') {
      navigator.storage.persisted().then(setPersisted, () => setPersisted(null));
    }
  }, [load]);

  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>Data folder</h2>
      {error !== null ? (
        <div className="error-banner">
          Failed to read the folder details: {error}{' '}
          <button onClick={() => void load()} style={{ marginLeft: 8 }}>
            Retry
          </button>
        </div>
      ) : meta === null ? (
        <div className="muted">Loading…</div>
      ) : (
        <>
          <code style={{ fontSize: 13, wordBreak: 'break-all' }}>{meta.dataDir}</code>
          <p className="muted">
            Your profile (<code>profile.json</code>) and your plan (<code>plan.json</code>, saved on
            every change) are human-readable JSON in this folder. Back it up — <code>git init</code>{' '}
            works well.
          </p>
          {meta.runCache !== undefined ? (
            <p className="muted">
              Run cache: {meta.runCache.files.toLocaleString('en-US')} runs ·{' '}
              {formatBytes(meta.runCache.bytes)} — grows without bound; <code>runs/</code> is
              deletable and costs only recomputation.
            </p>
          ) : null}
          <p className="muted">
            Engine v{meta.engineVersion}
            {meta.dataDirInitialized ? '' : ' · data folder not yet initialized'}
            {persisted !== null ? ` · storage ${persisted ? 'persistent' : 'best-effort'}` : ''}
          </p>
          {backendMode === 'local' ? (
            <>
              <button onClick={() => void switchStorage()}>Switch storage…</button>
              <p className="muted" style={{ marginTop: 6 }}>
                Your files stay where they are; you&apos;ll choose where data lives again on
                reload.
              </p>
            </>
          ) : null}
        </>
      )}
    </div>
  );
}
