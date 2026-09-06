/**
 * SAVE A COPY / RESTORE FROM A FILE — the whole data folder as one JSON file.
 *
 * WHO IT IS FOR. Primarily Safari and Firefox, where there is no folder
 * picker and the app runs in browser-private demo storage: without a way to
 * get data out, those browsers can only ever be a toy, and the standing demo
 * banner says as much. With these two buttons they are a real, if manual,
 * place to work — save when you finish, restore when you come back. It is
 * offered in folder mode too, where the same file is a portable snapshot you
 * can mail to yourself or carry to another machine.
 *
 * LOCAL MODE ONLY. The card renders nothing under the parked HTTP server:
 * the implementation reaches into the browser's booted data folder, and the
 * download is a Blob in the page. Same discipline as "Switch storage…" on
 * the card above.
 *
 * THE RESTORE IS BEHIND A CONFIRM, and the confirm says what it will do in
 * the words that matter — it replaces what is in the folder now. Restore
 * never deletes (portableBackup's own contract), so the honest verb is
 * "replace", not "wipe"; a reload follows, because the stores read at boot.
 */
import { useCallback, useRef, useState } from 'react';
import { backendMode } from '../../api';

type Status =
  | { kind: 'idle' }
  | { kind: 'working'; what: 'save' | 'restore' }
  | { kind: 'saved'; filename: string; fileCount: number }
  | { kind: 'restored'; fileCount: number }
  | { kind: 'error'; message: string };

export function BackupCard() {
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const fileInput = useRef<HTMLInputElement | null>(null);

  const save = useCallback(async () => {
    setStatus({ kind: 'working', what: 'save' });
    try {
      const { downloadBackup } = await import('../../local/backup');
      const { filename, fileCount } = await downloadBackup();
      setStatus({ kind: 'saved', filename, fileCount });
    } catch (e) {
      setStatus({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  }, []);

  const restore = useCallback(async (file: File) => {
    // The confirm is BEFORE any read: a mis-click should cost nothing, not
    // parse a file and then ask.
    const ok = window.confirm(
      `Restore from ${file.name}?\n\n` +
        'Every file in the backup replaces the one in your data folder. ' +
        'Anything the backup does not contain is left alone. The page reloads afterwards.',
    );
    if (!ok) return;
    setStatus({ kind: 'working', what: 'restore' });
    try {
      const { restoreBackupFromFile } = await import('../../local/backup');
      const { fileCount } = await restoreBackupFromFile(file);
      setStatus({ kind: 'restored', fileCount });
      location.reload();
    } catch (e) {
      setStatus({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  }, []);

  if (backendMode !== 'local') return null;

  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>Save a copy</h2>
      <p className="muted">
        Your whole data folder — profile, plan, plan history, net-worth ledger, assumptions and
        scenarios — as one JSON file you can read in any text editor. The run cache is left out;
        it costs only recomputation.
      </p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button onClick={() => void save()} disabled={status.kind === 'working'}>
          {status.kind === 'working' && status.what === 'save' ? 'Saving…' : 'Save a copy…'}
        </button>
        <button
          onClick={() => fileInput.current?.click()}
          disabled={status.kind === 'working'}
        >
          {status.kind === 'working' && status.what === 'restore' ? 'Restoring…' : 'Restore from a file…'}
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="application/json,.json"
          style={{ display: 'none' }}
          onChange={(e) => {
            const file = e.target.files?.[0];
            // Clear the input so picking the SAME file twice fires onChange
            // the second time — otherwise a failed restore cannot be retried.
            e.target.value = '';
            if (file) void restore(file);
          }}
        />
      </div>
      {status.kind === 'saved' ? (
        <p className="muted" style={{ marginTop: 8 }}>
          Saved <code>{status.filename}</code> — {status.fileCount.toLocaleString('en-US')} files.
        </p>
      ) : null}
      {status.kind === 'error' ? (
        <div className="error-banner" style={{ marginTop: 8 }}>
          {status.message}
        </div>
      ) : null}
    </div>
  );
}
