/**
 * ONE profile document per module page: the load / draft / edit-mode / save
 * machinery every module that edits profile.json shares, extracted from the
 * retired ProfilePage so twelve modules cannot each grow a variant.
 *
 * THE MODEL (the owner's standard, 2026-08-30): a module opens in VIEW mode.
 * Edit turns the same layout editable in place; Save writes the whole
 * profile back (get-mutate-put, the app's one update idiom) and returns to
 * view mode; Cancel restores the last-saved answer. `rev` remounts the
 * blur-committed field primitives on cancel/reload so their local text
 * cannot survive a restore (the same trick ProfilePage used).
 *
 * TWO WRITE PATHS, on purpose:
 *   - save() commits the edit-mode draft;
 *   - mutateAndSave() applies one mutation and writes IMMEDIATELY — for
 *     row deletion and row creation, which the standard performs outside
 *     edit mode (a trashcan click is not an edit session).
 *
 * The dirty-form blocker is wired here so leaving any module with unsaved
 * edit-mode changes raises the one shared prompt.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Profile } from '../../shared/types';
import { stableStringify } from '../../shared/util';
import { api } from '../api';
import { useToast } from '../toast';
import { useDirtyFormBlocker, type DirtyFormBlocker } from '../dirtyFormBlocker';

export interface ProfileDoc {
  /** The draft the forms bind to (equal to `saved` outside edit mode). */
  profile: Profile | null;
  saved: Profile | null;
  loading: boolean;
  loadError: string | null;
  saveError: string | null;
  saving: boolean;
  editing: boolean;
  dirty: boolean;
  /** Remount key for blur-committed fields; bumped on load/cancel/save. */
  rev: number;
  reload: () => Promise<void>;
  enterEdit: () => void;
  /** Back to view mode, draft restored to the last-saved answer. */
  cancelEdit: () => void;
  /** Edit-mode mutation of the draft (structuredClone + mutate, as ever). */
  update: (mutate: (p: Profile) => void) => void;
  /** Commit the draft; true on success (view mode), false on failure. */
  save: () => Promise<boolean>;
  /** Apply one mutation and write immediately (add / delete a record). */
  mutateAndSave: (mutate: (p: Profile) => void) => Promise<boolean>;
  blocker: DirtyFormBlocker;
}

export function useProfileDoc(): ProfileDoc {
  const { showToast } = useToast();
  const [saved, setSaved] = useState<Profile | null>(null);
  const [draft, setDraft] = useState<Profile | null>(null);
  const [rev, setRev] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  /** Serialises writes so two PUTs can never land on the file out of order. */
  const writeChain = useRef<Promise<void>>(Promise.resolve());
  /** The saved answer, readable from stable callbacks without stale closures. */
  const savedRef = useRef<Profile | null>(null);
  useEffect(() => {
    savedRef.current = saved;
  }, [saved]);
  /**
   * The draft, SYNCHRONOUSLY current. React state lags a render behind, and
   * mutateAndSave must build each write on top of the previous one even when
   * two arrive inside one in-flight PUT — cloning the render-time draft there
   * once resurrected a deleted row: delete A (PUT in flight), delete B, and
   * B's payload still contained A. Every mutation goes through this ref
   * first; the effect keeps it in step with edit-mode setDraft updates.
   */
  const draftRef = useRef<Profile | null>(null);
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  const reload = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    setSaveError(null);
    try {
      const p = await api.getProfile();
      setSaved(p);
      setDraft(structuredClone(p));
      setEditing(false);
      setRev((r) => r + 1);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const update = useCallback((mutate: (p: Profile) => void) => {
    setDraft((d) => {
      if (!d) return d;
      const next = structuredClone(d);
      mutate(next);
      return next;
    });
  }, []);

  const enterEdit = useCallback(() => {
    setSaveError(null);
    setEditing(true);
  }, []);

  const cancelEdit = useCallback(() => {
    setDraft(savedRef.current === null ? null : structuredClone(savedRef.current));
    setSaveError(null);
    setEditing(false);
    setRev((r) => r + 1);
  }, []);

  /**
   * One PUT, chained behind any in flight. `endEdit` separates the two
   * callers: save() commits an edit session and leaves edit mode on success;
   * mutateAndSave() is an immediate act with no session to end — and its
   * completion must not touch the edit state at all, or a slow delete's
   * resolution would eject the user from an edit session they started on
   * some OTHER record while the write was in flight.
   */
  const write = useCallback(
    async (next: Profile, opts: { endEdit: boolean }): Promise<boolean> => {
      setSaving(true);
      setSaveError(null);
      const attempt = writeChain.current.then(() => api.putProfile(next));
      writeChain.current = attempt.then(
        () => undefined,
        () => undefined,
      );
      try {
        await attempt;
        savedRef.current = structuredClone(next);
        setSaved(savedRef.current);
        if (opts.endEdit) {
          setEditing(false);
          setRev((r) => r + 1);
        }
        showToast('Saved');
        return true;
      } catch (e) {
        setSaveError(e instanceof Error ? e.message : String(e));
        if (!opts.endEdit && draftRef.current === next) {
          // An immediate write failed and nothing newer superseded it: the
          // optimistic draft no longer matches the disk, so fall back to the
          // last answer known to be on it. The error banner says why.
          draftRef.current = savedRef.current === null ? null : structuredClone(savedRef.current);
          setDraft(draftRef.current);
        }
        return false;
      } finally {
        setSaving(false);
      }
    },
    [showToast],
  );

  const save = useCallback(async (): Promise<boolean> => {
    const current = draftRef.current;
    if (current === null) return false;
    return write(current, { endEdit: true });
  }, [write]);

  const mutateAndSave = useCallback(
    async (mutate: (p: Profile) => void): Promise<boolean> => {
      const base = draftRef.current;
      if (base === null) return false;
      const next = structuredClone(base);
      mutate(next);
      // The ref is advanced SYNCHRONOUSLY, so a second act arriving before
      // this PUT resolves builds on this result rather than the stale render.
      draftRef.current = next;
      setDraft(next);
      return write(next, { endEdit: false });
    },
    [write],
  );

  const dirty =
    editing &&
    draft !== null &&
    saved !== null &&
    stableStringify(draft) !== stableStringify(saved);

  const blocker = useDirtyFormBlocker(dirty, { onDiscard: cancelEdit });

  return {
    profile: draft,
    saved,
    loading,
    loadError,
    saveError,
    saving,
    editing,
    dirty,
    rev,
    reload,
    enterEdit,
    cancelEdit,
    update,
    save,
    mutateAndSave,
    blocker,
  };
}
