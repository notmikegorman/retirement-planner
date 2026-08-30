/**
 * The strict confirm — same rules as every modal here (the smplkit
 * standard): no backdrop dismiss, the only ways out are the two buttons or
 * Escape (which is Cancel). Focus moves to Cancel on open so a keyboard
 * user's next keys land in the dialog rather than the dimmed page behind
 * it, and Cancel-first means a reflexive Enter never deletes anything.
 * Used for every row/record deletion; DiscardChangesPrompt is its sibling
 * for unsaved edits.
 */
import { useEffect, useRef } from 'react';

export function ConfirmModal(props: {
  title: string;
  body: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  return (
    <div
      className="deleteConfirmOverlay"
      role="presentation"
      onKeyDown={(e) => {
        if (e.key === 'Escape') props.onCancel();
      }}
    >
      <div className="deleteConfirmPanel" role="dialog" aria-modal="true">
        <h3>{props.title}</h3>
        <p>{props.body}</p>
        <div className="deleteConfirmActions">
          <button ref={cancelRef} type="button" onClick={props.onCancel}>
            Cancel
          </button>
          <button type="button" className="danger" onClick={props.onConfirm}>
            {props.confirmLabel ?? 'Delete'}
          </button>
        </div>
      </div>
    </div>
  );
}
