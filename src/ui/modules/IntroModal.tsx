/**
 * The FIRST-VISIT intro modal — ground rules that used to sit as preamble
 * text above a table (Expenses' today's-dollars/inherited-cells note first,
 * then Tithing's, both moved here at the owner's ask, 2026-08-30) so the
 * pages themselves are just their content.
 *
 * Shown once per visit at most and never again once dismissed with the box
 * ticked. Same modal rules as ConfirmModal: no backdrop dismiss, Escape
 * closes (identically to the button — both honor the checkbox), focus lands
 * on the button so a reflexive Enter just closes it.
 *
 * The flag is browser-local UI memory like the remembered tabs — and
 * deliberately NOT cleared by File > New: "do not show this again" is a
 * statement about the reader, not the folder.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';

function introSeen(storageKey: string): boolean {
  try {
    return localStorage.getItem(storageKey) !== null;
  } catch {
    // No storage means the choice cannot be remembered — showing the modal
    // on every visit would nag, so err on the quiet side.
    return true;
  }
}

export function IntroModal(props: { title: string; storageKey: string; children: ReactNode }) {
  const [open, setOpen] = useState(() => !introSeen(props.storageKey));
  const [dontShowAgain, setDontShowAgain] = useState(true);
  const okRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (open) okRef.current?.focus();
  }, [open]);
  if (!open) return null;
  const close = () => {
    if (dontShowAgain) {
      try {
        localStorage.setItem(props.storageKey, '1');
      } catch {
        // Nothing to do: the modal still closes, and introSeen()'s own
        // failure branch keeps it from nagging.
      }
    }
    setOpen(false);
  };
  return (
    <div
      className="deleteConfirmOverlay"
      role="presentation"
      onKeyDown={(e) => {
        if (e.key === 'Escape') close();
      }}
    >
      <div
        className="deleteConfirmPanel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`intro-${props.storageKey}`}
      >
        <h3 id={`intro-${props.storageKey}`}>{props.title}</h3>
        {props.children}
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '12px 0 4px' }}>
          <input
            type="checkbox"
            checked={dontShowAgain}
            onChange={(e) => setDontShowAgain(e.target.checked)}
          />
          Do not show this again
        </label>
        <div className="deleteConfirmActions">
          <button ref={okRef} type="button" className="primary" onClick={close}>
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}
