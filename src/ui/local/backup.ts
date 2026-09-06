/**
 * SAVE AND RESTORE, the browser half — the download and the upload that wrap
 * src/store/portableBackup.ts's environment-neutral core.
 *
 * LOCAL MODE ONLY, and lazily imported by the Settings card that offers it,
 * for the same reason FolderControl lazily imports the guard: this module
 * reaches into the booted local backend, and an HTTP-mode session must not
 * drag that chunk into its bundle to render a page it will not use.
 *
 * The download is an object URL on a Blob, clicked and revoked. There is no
 * server in this app to ask for a file, and none is wanted: the bytes are
 * already in the page.
 */
import {
  backupFilename,
  collectBackup,
  parseBackup,
  restoreBackup,
} from '../../store/portableBackup';
import { bootedFileStore } from './localBackend';

/**
 * Collect the folder and hand the browser a download. Returns the filename
 * and how many files travelled, so the card can say what happened rather
 * than flashing a spinner and going quiet.
 */
export async function downloadBackup(): Promise<{ filename: string; fileCount: number }> {
  const envelope = await collectBackup(bootedFileStore());
  const filename = backupFilename();
  const blob = new Blob([`${JSON.stringify(envelope, null, 2)}\n`], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    // Firefox needs the anchor in the document before a synthetic click
    // counts; Chrome does not care. Appending costs nothing either way.
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    // Revoke on the next turn: revoking synchronously after click() races
    // the browser's own fetch of the URL in some engines.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
  return { filename, fileCount: Object.keys(envelope.files).length };
}

/**
 * Read an uploaded backup and write it into the data folder. Throws with a
 * human-readable message when the file is not a backup — parseBackup owns
 * every one of those messages, so the card only has to render `err.message`.
 *
 * The caller reloads afterwards: the stores read at boot and hold state in
 * module scope, so a restore that did not reload would leave the page
 * showing the data it replaced.
 */
export async function restoreBackupFromFile(file: File): Promise<{ fileCount: number }> {
  const envelope = parseBackup(await file.text());
  const written = await restoreBackup(bootedFileStore(), envelope);
  return { fileCount: written.length };
}
