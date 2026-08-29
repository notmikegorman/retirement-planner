/**
 * The boot-gate PAGES: the first-visit storage question, the returning
 * folder user's reconnect click, and the no-picker fallback banner (D8).
 * main.tsx renders exactly one of these instead of the app whenever
 * computeBootGate() says the boot cannot proceed on its own — always
 * because the next step legally requires a user gesture (the picker, the
 * permission re-grant), never as decoration.
 *
 * The WORDS carry the design. Every claim on these screens is one the code
 * keeps: the folder option really is plain JSON files the owner can read
 * and back up; browser-private storage really does vanish with Clear
 * browsing data; simulations really do run on this machine only. The
 * chooser must persuade nobody — it exists so the durable choice and the
 * convenient choice are made knowingly.
 */
import { useState, type CSSProperties } from 'react';
import {
  requestStoragePersistence,
  saveFolderHandle,
  supportsFolderPicker,
  writeStorageChoice,
} from './storageChoice';

const shell: CSSProperties = { maxWidth: '44rem', margin: '4rem auto', padding: '0 1rem' };

/** Console-only surfacing of the one-time persistence request — quiet on purpose. */
function requestPersistenceQuietly(): void {
  void requestStoragePersistence().then((granted) => {
    if (granted === null) return;
    console.log(
      granted
        ? '[storage] the browser granted persistent storage for this origin'
        : '[storage] persistent storage was not granted — storage stays best-effort',
    );
  });
}

export function StorageChooser({
  canPickFolder,
  onChosen,
}: {
  canPickFolder: boolean;
  onChosen: () => void;
}) {
  const [error, setError] = useState<string | null>(null);

  async function pickFolder(): Promise<void> {
    setError(null);
    try {
      const picker = window.showDirectoryPicker;
      if (picker === undefined) throw new Error('this browser has no folder picker');
      const handle = await picker.call(window, { id: 'fplan-data', mode: 'readwrite' });
      await saveFolderHandle(handle);
      writeStorageChoice('folder');
      requestPersistenceQuietly();
      onChosen();
    } catch (err) {
      // Closing the picker is an answer ("not now"), not an error.
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function useBrowserStorage(): void {
    writeStorageChoice('opfs');
    requestPersistenceQuietly();
    onChosen();
  }

  return (
    <div style={shell}>
      <h1>Where should your data live?</h1>
      <p>
        This planner runs entirely on your machine — the simulations, the tax math, and every
        file. Nothing you enter is uploaded anywhere. The only decision is where the files go.
      </p>

      {!canPickFolder ? (
        <div className="warn-banner" role="status">
          This browser can&apos;t hold a durable folder connection — the folder picker (the File
          System Access API) ships in Chrome, Edge, and Brave. You can still explore the whole
          app in browser-private demo storage below; for real, file-backed use, open this page
          in one of those browsers.
        </div>
      ) : (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>A folder on this computer</h2>
          <p className="muted">
            Your profile, plan, and net-worth ledger live as plain JSON files in a folder you
            pick — readable, diffable, and yours to back up (copy it, git it, sync it). Pick an
            empty folder to start fresh with a starter household, or pick a folder that already
            holds planner data to open it. This is the durable choice.
          </p>
          <button className="primary" onClick={() => void pickFolder()}>
            Pick a folder…
          </button>
        </div>
      )}

      <div className="card">
        <h2 style={{ marginTop: 0 }}>
          {canPickFolder ? 'Browser-private storage' : 'Browser-private demo storage'}
        </h2>
        <p className="muted">
          No picker and no prompts: the files live inside this browser profile, invisible on
          disk. Good for trying the app — but Clear browsing data erases everything, and no
          ordinary backup ever sees it.
          {canPickFolder ? ' You can switch to a real folder later (Dashboard → Switch storage).' : ''}
        </p>
        <button className={canPickFolder ? '' : 'primary'} onClick={useBrowserStorage}>
          {canPickFolder ? 'Use browser-private storage' : 'Try it in demo storage'}
        </button>
      </div>

      {error !== null ? <div className="error-banner">Could not use that folder: {error}</div> : null}

      <p className="muted">
        Either way: simulations run on this machine, and your data never leaves it.
      </p>
    </div>
  );
}

export function FolderReconnect({
  folderName,
  requestAccess,
  onReady,
  onChooseOther,
}: {
  folderName: string;
  /** Runs handle.requestPermission behind this click; true when granted. */
  requestAccess: () => Promise<boolean>;
  onReady: () => void;
  onChooseOther: () => void;
}) {
  const [refused, setRefused] = useState(false);

  async function reconnect(): Promise<void> {
    setRefused(false);
    if (await requestAccess()) onReady();
    else setRefused(true);
  }

  return (
    <div style={shell}>
      <h1>Reconnect your data folder</h1>
      <p>
        Your data lives in the folder <strong>&quot;{folderName}&quot;</strong>. The browser
        requires a click before a page may touch files again — one click per visit (installing
        the app from the address bar makes the grant stick).
      </p>
      <button className="primary" onClick={() => void reconnect()}>
        Reconnect &quot;{folderName}&quot;
      </button>{' '}
      <button onClick={onChooseOther}>Choose different storage…</button>
      {refused ? (
        <div className="error-banner" style={{ marginTop: 12 }}>
          The browser didn&apos;t grant access. Try again, or choose different storage — the
          folder and everything in it are untouched either way.
        </div>
      ) : null}
    </div>
  );
}

/**
 * The standing banner for D8's fallback (Safari/Firefox: OPFS was the only
 * door, so every session is honestly demo-scoped). Rendered above the app —
 * persistent, not dismissible, because its claim never stops being true and
 * a dismissed banner is how a demo edit gets mistaken for a durable record.
 */
export function DemoStorageBanner() {
  return (
    <div className="warn-banner demo-banner" role="status">
      <strong>Demo storage.</strong> This browser can&apos;t hold a durable folder connection,
      so your edits live only inside this browser profile — Clear browsing data erases them,
      and no file on disk ever holds them. For durable, file-backed use, open this page in
      Chrome, Edge, or Brave.
    </div>
  );
}

export { supportsFolderPicker };
