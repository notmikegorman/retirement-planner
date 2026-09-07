/**
 * SHOW A FRIEND MODE — the toggle, and the two sentences that make it safe
 * to trust.
 *
 * WHAT IT DOES: turns the mode on or off and reloads. Everything else lives
 * in storageChoice.ts, whose header explains why the mode is a separate OPFS
 * folder holding the fictional example household rather than a mask over
 * your own numbers: a mask has to be right at every card, table, tooltip,
 * chart axis and export, and one missed site is the whole feature failing at
 * the only moment it matters. A different folder has no such surface — your
 * data is never opened, so nothing can leak it.
 *
 * WHAT THE CARD MUST SAY OUT LOUD, because getting either wrong is the
 * user's problem and not the code's:
 *
 *   - the sample household is NOT your plan. It is a complete, realistic,
 *     invented one (Alex and Jordan, data-defaults/profile.starter.json), so
 *     the app demonstrates properly — but nobody should mistake its answer
 *     for yours;
 *   - edits made in the mode stay with the sample. That is the point, and it
 *     is also the trap: a real change typed while the mode is on does not
 *     reach your data. The sidebar says "Show a friend mode" the whole time
 *     for exactly this reason.
 *
 * LOCAL MODE ONLY, like the two cards above it: the storage override is a
 * browser-storage mechanism and the parked Node server owns its own folder.
 */
import { useCallback, useState } from 'react';
import { backendMode } from '../../api';
import { readFriendMode, resetFriendFolder, writeFriendMode } from '../../local/storageChoice';

export function FriendModeCard() {
  // Read once, at mount: the value only changes through this button, and the
  // button reloads the page.
  const [on] = useState(() => backendMode === 'local' && readFriendMode());
  const [busy, setBusy] = useState(false);

  const toggle = useCallback(() => {
    setBusy(true);
    writeFriendMode(!on);
    location.reload();
  }, [on]);

  const reset = useCallback(() => {
    if (
      !window.confirm(
        'Start the sample over?\n\nEverything changed in the sample household is discarded ' +
          'and a fresh copy is seeded. Your own data is not involved.',
      )
    ) {
      return;
    }
    setBusy(true);
    void resetFriendFolder().finally(() => location.reload());
  }, []);

  if (backendMode !== 'local') return null;

  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>Show a friend mode</h2>
      {on ? (
        <>
          <p className="muted">
            <strong>On.</strong> Everything on screen belongs to an invented household — your own
            data is not open at all, and nothing here can reach it. Changes you make stay with the
            sample.
          </p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button onClick={toggle} disabled={busy}>
              {busy ? 'Switching…' : 'Turn off and go back to my data'}
            </button>
            <button onClick={reset} disabled={busy}>
              Start the sample over
            </button>
          </div>
          <p className="muted" style={{ marginTop: 6 }}>
            Starting over throws the sample away and seeds a fresh one — useful after a demo has
            been walked through a few times, or if the sample has picked up something it should
            not have. It never touches your own data.
          </p>
        </>
      ) : (
        <>
          <p className="muted">
            Runs the app on a complete, invented household instead of yours, so you can show
            someone how it works without your real finances on screen. Your own data stays exactly
            where it is and is not opened while the mode is on; turning the mode off brings it
            straight back.
          </p>
          <button onClick={toggle} disabled={busy}>
            {busy ? 'Switching…' : 'Turn on Show a friend mode'}
          </button>
          <p className="muted" style={{ marginTop: 6 }}>
            The sidebar reads <strong>Show a friend mode</strong> the whole time it is on, so a
            change you meant for your own plan cannot land in the sample by mistake.
          </p>
        </>
      )}
    </div>
  );
}
