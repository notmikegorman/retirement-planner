/**
 * Ambient declarations for the Chromium-only half of the File System Access
 * API. TypeScript's lib.dom covers the parts every engine ships (the handle
 * types, OPFS via navigator.storage.getDirectory) but not the picker or the
 * permission calls, which exist only in Chromium — exactly the surface the
 * Phase-7 boot flow branches on. Everything here is declared OPTIONAL, so
 * call sites are forced to feature-detect (`supportsFolderPicker()`,
 * `handle.queryPermission?.(...)`) rather than assume Chromium; a bare call
 * that would throw on Safari fails to compile instead.
 */

interface FileSystemHandlePermissionDescriptor {
  mode?: 'read' | 'readwrite';
}

interface FileSystemHandle {
  /** Chromium only: what the browser would say without prompting. */
  queryPermission?(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
  /** Chromium only: may show the permission prompt; needs a user gesture. */
  requestPermission?(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
}

interface DirectoryPickerOptions {
  /** Lets the browser remember a per-purpose starting directory. */
  id?: string;
  mode?: 'read' | 'readwrite';
}

interface Window {
  /** Chromium only (Chrome/Edge/Opera; Brave ships it). User gesture required. */
  showDirectoryPicker?(options?: DirectoryPickerOptions): Promise<FileSystemDirectoryHandle>;
}
