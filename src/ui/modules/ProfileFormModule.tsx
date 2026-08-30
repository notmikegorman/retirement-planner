/**
 * THE SINGLE-THING MODULE (the owner's rule, 2026-08-30: "if it is just one
 * thing, then you show that one thing") — a banner plus one view/edit form
 * over the profile document.
 *
 * VIEW MODE IS THE SAME LAYOUT AS EDIT MODE. The whole body sits in one
 * <fieldset>, disabled outside edit mode: the browser switches every nested
 * control off in one move — no prop-drilling a `disabled` through the cards
 * — and the stylesheet then dresses disabled controls as plain values
 * (transparent border and background, full text color) so entering edit
 * mode changes nothing but the affordances. The fieldset is keyed by the
 * doc's rev so Cancel remounts the blur-committed field primitives, whose
 * local text would otherwise survive the restore.
 *
 * Banner actions are the standard set: [Edit] in view mode, [Cancel] [Save]
 * in edit mode, with the unsaved-changes pill beside the title. Deleting is
 * absent by construction — a single thing has nothing to delete.
 */
import type { ReactNode } from 'react';
import type { Profile } from '../../shared/types';
import { DiscardChangesPrompt } from '../dirtyFormBlocker';
import { ModuleBanner } from './ModuleBanner';
import { useProfileDoc, type ProfileDoc } from './useProfileDoc';

export function ProfileFormModule(props: {
  title: string;
  /** The form body, bound to the draft. Rendered inside the fieldset. */
  children: (profile: Profile, doc: ProfileDoc) => ReactNode;
  /**
   * Content below the form, OUTSIDE the fieldset — always-active cards, and
   * anything interactive in view mode (a modal's buttons would come up
   * disabled inside the fieldset). The function form gets the same draft and
   * doc the body does, for after-content that depends on profile state.
   */
  after?: ReactNode | ((profile: Profile, doc: ProfileDoc) => ReactNode);
  /**
   * A view-switching strip, rendered ABOVE the fieldset and outside it —
   * tabs are navigation, not edits, and inside the fieldset view mode would
   * disable them. The caller owns the strip and the state; the draft (and
   * an edit session) survives a switch because both live on the doc.
   */
  tabs?: ReactNode;
}) {
  const doc = useProfileDoc();

  if (doc.loading) {
    return (
      <>
        <ModuleBanner title={props.title} />
        <div className="moduleBody">
          <div className="muted">Loading…</div>
        </div>
      </>
    );
  }

  if (doc.loadError !== null || doc.profile === null) {
    return (
      <>
        <ModuleBanner title={props.title} />
        <div className="moduleBody">
          <div className="error-banner">
            Failed to load the profile: {doc.loadError ?? 'missing data'}
          </div>
          <button onClick={() => void doc.reload()}>Retry</button>
        </div>
      </>
    );
  }

  return (
    <>
      <ModuleBanner
        title={props.title}
        pill={
          doc.editing ? (
            <span className={doc.dirty ? 'statusPill isDirty' : 'statusPill isSaved'}>
              {doc.dirty ? 'Unsaved changes' : 'Editing'}
            </span>
          ) : null
        }
        actions={
          doc.editing ? (
            <>
              <button disabled={doc.saving} onClick={doc.cancelEdit}>
                Cancel
              </button>
              <button className="primary" disabled={doc.saving} onClick={() => void doc.save()}>
                {doc.saving ? 'Saving…' : 'Save'}
              </button>
            </>
          ) : (
            <button onClick={doc.enterEdit}>Edit</button>
          )
        }
      />
      <div className="moduleBody">
        {doc.saveError !== null ? (
          <div className="error-banner">Save failed: {doc.saveError}</div>
        ) : null}
        {props.tabs}
        <fieldset key={doc.rev} disabled={!doc.editing} className="moduleFieldset">
          {props.children(doc.profile, doc)}
        </fieldset>
        {typeof props.after === 'function' ? props.after(doc.profile, doc) : props.after}
      </div>
      <DiscardChangesPrompt blocker={doc.blocker} />
    </>
  );
}
