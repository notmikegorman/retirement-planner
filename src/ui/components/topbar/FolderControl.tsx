/**
 * THE FOLDER CONTROL — the topbar's File menu (File > New / File > Open,
 * 2026-08-29). It always shows the CURRENT folder's name; clicking it opens
 * a small menu: the remembered-folders list (every folder this browser
 * profile was ever granted, most recently opened first), "Open another
 * folder…", and "New folder…". Every rule and every sentence lives in
 * folderControlLogic.ts; this file is the wiring.
 *
 * SWITCHING IS A RELOAD, ON PURPOSE. The guard machinery, the composed
 * stores, the memoized local backend (api.ts's once-per-tab boot), the
 * workers, and every page's state were all built for boot-time acquisition
 * with the folder fixed for the tab's lifetime. Rebinding them in place
 * would mean invalidating the backend memo, retiring workers, and flushing
 * React state across six pages — a second lifecycle for a transition that
 * happens a few times a day at most. So a switch is: refuse if work is in
 * flight (the beforeunload guards must never argue with a reload that
 * already released the guard), re-request folder permission behind the
 * click gesture, write the choice, RELEASE the writer guard gracefully
 * (guardClient.releaseHeldGuard — heartbeat stopped, lease deleted, Web
 * Lock freed, so the folder being left is immediately openable elsewhere),
 * and location.reload() into the boot gate, which re-runs against the new
 * handle exactly as a fresh visit would — reconnect page, zero-start setup
 * step and all.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, backendMode } from '../../api';
import {
  listRememberedFolders,
  openRememberedFolder,
  readStorageChoice,
  loadFolderHandle,
  saveFolderHandle,
  supportsFolderPicker,
  writeStorageChoice,
  type RememberedFolder,
} from '../../local/storageChoice';
import {
  DEMO_FOLDER_NOTE,
  NEW_FOLDER_HINT,
  OPFS_STAYS_NOTE,
  SERVER_FOLDER_NOTE,
  SWITCH_BUSY_NOTE,
  folderControlLabel,
  folderMenuKind,
  type FolderControlFacts,
} from './folderControlLogic';

/**
 * Is a scoring run or a search in flight? Asked through dynamic imports so
 * the HTTP bundle keeps loading not one byte of the local chunk — the same
 * discipline as api.ts's lazy backend. Only ever called in local mode, where
 * that chunk is already loaded, so the import is a lookup, not a fetch.
 */
async function localWorkInFlight(): Promise<boolean> {
  const [{ scoringInFlight }, { searchesInFlight }] = await Promise.all([
    import('../../local/scoringGuard'),
    import('../../local/searchClient'),
  ]);
  return scoringInFlight() || searchesInFlight();
}

/** Release the held guard (local mode), then reload into the boot gate. */
async function releaseGuardAndReload(): Promise<void> {
  if (backendMode === 'local') {
    const { releaseHeldGuard } = await import('../../local/guardClient');
    await releaseHeldGuard();
  }
  location.reload();
}

export function FolderControl() {
  const [facts, setFacts] = useState<FolderControlFacts | null>(null);
  const [open, setOpen] = useState(false);
  const [folders, setFolders] = useState<RememberedFolder[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (backendMode === 'http') {
      setFacts({ mode: 'http', dataDir: null });
      api
        .meta()
        .then((m) => {
          if (!cancelled) setFacts({ mode: 'http', dataDir: m.dataDir });
        })
        .catch(() => {
          // The label stays "…"; the Dashboard is where meta failures speak.
        });
      return () => {
        cancelled = true;
      };
    }
    const choice = readStorageChoice();
    const canPickFolder = supportsFolderPicker();
    setFacts({ mode: 'local', choice, canPickFolder, folderName: null });
    void (async () => {
      const saved = choice === 'folder' ? await loadFolderHandle() : null;
      const list = canPickFolder ? await listRememberedFolders() : [];
      if (cancelled) return;
      setFacts({
        mode: 'local',
        choice,
        canPickFolder,
        folderName: saved?.handle.name ?? null,
      });
      setCurrentId(saved?.id ?? null);
      setFolders(list);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // A menu that stays open behind an unrelated click reads as stuck.
  useEffect(() => {
    if (!open) return;
    const close = (ev: MouseEvent) => {
      if (rootRef.current !== null && !rootRef.current.contains(ev.target as Node)) {
        setOpen(false);
        setNotice(null);
      }
    };
    const escape = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        setOpen(false);
        setNotice(null);
      }
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  /** The in-flight refusal, shared by every switch path. */
  const refuseIfBusy = useCallback(async (): Promise<boolean> => {
    if (await localWorkInFlight()) {
      setNotice(SWITCH_BUSY_NOTE);
      return true;
    }
    return false;
  }, []);

  /** File > Open on a listed folder. */
  const openListed = async (folder: RememberedFolder): Promise<void> => {
    setNotice(null);
    if (await refuseIfBusy()) return;
    // The permission re-request runs INSIDE this click's gesture, so the
    // common case reloads straight into the app. A refusal still proceeds:
    // the boot gate's reconnect page owns that state and says what to do.
    try {
      await folder.handle.requestPermission?.({ mode: 'readwrite' });
    } catch {
      // The gate re-asks; proceeding is never less safe than booting.
    }
    if ((await openRememberedFolder(folder.id)) === null) {
      setNotice('That folder is no longer in the remembered list — use Open another folder…');
      return;
    }
    writeStorageChoice('folder');
    await releaseGuardAndReload();
  };

  /** File > Open (another) and File > New: one picker, one boot, one rule. */
  const pickAndOpen = async (): Promise<void> => {
    setNotice(null);
    if (await refuseIfBusy()) return;
    try {
      const picker = window.showDirectoryPicker;
      if (picker === undefined) throw new Error('this browser has no folder picker');
      const handle = await picker.call(window, { id: 'fplan-data', mode: 'readwrite' });
      await saveFolderHandle(handle);
      writeStorageChoice('folder');
      await releaseGuardAndReload();
    } catch (err) {
      // Closing the picker is an answer ("not now"), not an error.
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setNotice(err instanceof Error ? err.message : String(err));
    }
  };

  if (facts === null) return null;
  const label = folderControlLabel(facts);
  const kind = folderMenuKind(facts);
  const onOpfs = facts.mode === 'local' && facts.choice === 'opfs';

  return (
    <div className="folder-control" ref={rootRef}>
      <button
        className="folder-toggle"
        aria-haspopup="menu"
        aria-expanded={open}
        title={`Data folder: ${label} — click for folders`}
        onClick={() => {
          setOpen((v) => !v);
          setNotice(null);
        }}
      >
        <span aria-hidden="true">🗂</span>
        <span className="folder-name">{label}</span>
      </button>

      {open && (
        <div className="folder-menu" role="menu" aria-label="Data folders">
          {kind === 'server-note' && <div className="muted">{SERVER_FOLDER_NOTE}</div>}
          {kind === 'demo-note' && <div className="muted">{DEMO_FOLDER_NOTE}</div>}
          {kind === 'switcher' && (
            <>
              {folders.length > 0 && (
                <div className="folder-menu-section">
                  {folders.map((f) => {
                    const current = f.id === currentId;
                    return (
                      <button
                        key={f.id}
                        role="menuitem"
                        className="folder-menu-item"
                        disabled={current}
                        onClick={() => void openListed(f)}
                      >
                        {f.handle.name}
                        {current ? <span className="muted"> — open now</span> : null}
                      </button>
                    );
                  })}
                </div>
              )}
              <div className="folder-menu-section">
                <button role="menuitem" className="folder-menu-item" onClick={() => void pickAndOpen()}>
                  Open another folder…
                </button>
                <button role="menuitem" className="folder-menu-item" onClick={() => void pickAndOpen()}>
                  New folder…
                </button>
                <div className="muted folder-menu-hint">{NEW_FOLDER_HINT}</div>
                {onOpfs && <div className="muted folder-menu-hint">{OPFS_STAYS_NOTE}</div>}
              </div>
            </>
          )}
          {notice !== null && (
            <div className="lib-warning warn" role="status" style={{ marginTop: 6 }}>
              {notice}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
