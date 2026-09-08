/**
 * WHO TO CALL, AND WHERE THINGS ARE — the Widow's Playbook's one editable
 * surface, and the only part of the profile that holds words rather than money.
 *
 * WHY IT EDITS DIRECTLY rather than through the module form's Edit/Save pair:
 * every other profile screen edits a household the owner is modelling, where a
 * draft that can be abandoned is the right shape. This is a list of phone
 * numbers being written down before they are needed, and the failure that
 * matters is a row typed and lost, not a row typed and regretted. Each commit
 * is a get-mutate-put through the ordinary profile door, so nothing here can
 * disagree with what the rest of the app reads.
 *
 * A NOTE ON WHAT THIS PUTS IN THE FILE. These rows are names, numbers and
 * addresses, and they travel with the data folder — every backup, every Save a
 * copy. That is the same bargain the balances already make, and the card says
 * so out loud rather than letting it be discovered.
 */
import { useCallback, useState } from 'react';
import { api } from '../../api';
import type { PlaybookContact, PlaybookDocument, Profile } from '../../../shared/types';

/** `c-1`, `d-3` — stable within the list, never re-keying a row on reorder. */
function nextId(prefix: string, taken: ReadonlySet<string>): string {
  let n = 1;
  while (taken.has(`${prefix}-${n}`)) n += 1;
  return `${prefix}-${n}`;
}

export function ContactsCard({
  profile,
  onSaved,
}: {
  profile: Profile;
  onSaved: (p: Profile) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const contacts = profile.contacts ?? [];
  const documents = profile.documents ?? [];

  /** Get-mutate-put: the whole profile back through the one door. */
  const commit = useCallback(
    async (mutate: (p: Profile) => void) => {
      setBusy(true);
      setError(null);
      const next = structuredClone(profile);
      mutate(next);
      try {
        await api.putProfile(next);
        onSaved(next);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [profile, onSaved],
  );

  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>Who to call, and where things are</h2>
      <p className="muted">
        The plan knows every balance and not one phone number. This is the part it cannot work out —
        and the part she would reach for first. It is saved in <code>profile.json</code> with
        everything else, so it travels with every backup and every Save a copy.
      </p>
      {error !== null ? <div className="error-banner">{error}</div> : null}

      <h3>People</h3>
      {contacts.length === 0 ? (
        <p className="muted">
          Nobody recorded. The attorney, the accountant, the executor, whoever holds the accounts.
        </p>
      ) : null}
      {contacts.map((c, i) => (
        <div className="row inlineRow" key={c.id} style={{ marginBottom: 6 }}>
          <input
            aria-label={`Role ${i + 1}`}
            placeholder="estate attorney"
            defaultValue={c.role}
            disabled={busy}
            onBlur={(e) =>
              void commit((p) => {
                const row = (p.contacts ?? []).find((x) => x.id === c.id);
                if (row) row.role = e.target.value;
              })
            }
          />
          <input
            aria-label={`Name ${i + 1}`}
            placeholder="name"
            defaultValue={c.name}
            disabled={busy}
            onBlur={(e) =>
              void commit((p) => {
                const row = (p.contacts ?? []).find((x) => x.id === c.id);
                if (row) row.name = e.target.value;
              })
            }
          />
          <input
            aria-label={`Phone ${i + 1}`}
            placeholder="phone"
            defaultValue={c.phone ?? ''}
            disabled={busy}
            onBlur={(e) =>
              void commit((p) => {
                const row = (p.contacts ?? []).find((x) => x.id === c.id);
                if (row) row.phone = e.target.value;
              })
            }
          />
          <button
            disabled={busy}
            onClick={() =>
              void commit((p) => {
                p.contacts = (p.contacts ?? []).filter((x) => x.id !== c.id);
              })
            }
          >
            Remove
          </button>
        </div>
      ))}
      <button
        disabled={busy}
        onClick={() =>
          void commit((p) => {
            const list: PlaybookContact[] = p.contacts ?? [];
            list.push({
              id: nextId('c', new Set(list.map((x) => x.id))),
              role: 'role',
              name: 'name',
            });
            p.contacts = list;
          })
        }
      >
        + Add a person
      </button>

      <h3 style={{ marginTop: 18 }}>Documents</h3>
      {documents.length === 0 ? (
        <p className="muted">
          Nothing recorded. The will, the trust, the deed, the policies, the password manager.
        </p>
      ) : null}
      {documents.map((d, i) => (
        <div className="row inlineRow" key={d.id} style={{ marginBottom: 6 }}>
          <input
            aria-label={`Document ${i + 1}`}
            placeholder="Will"
            defaultValue={d.label}
            disabled={busy}
            onBlur={(e) =>
              void commit((p) => {
                const row = (p.documents ?? []).find((x) => x.id === d.id);
                if (row) row.label = e.target.value;
              })
            }
          />
          <input
            aria-label={`Location ${i + 1}`}
            placeholder="where to find it"
            defaultValue={d.location}
            disabled={busy}
            onBlur={(e) =>
              void commit((p) => {
                const row = (p.documents ?? []).find((x) => x.id === d.id);
                if (row) row.location = e.target.value;
              })
            }
          />
          <button
            disabled={busy}
            onClick={() =>
              void commit((p) => {
                p.documents = (p.documents ?? []).filter((x) => x.id !== d.id);
              })
            }
          >
            Remove
          </button>
        </div>
      ))}
      <button
        disabled={busy}
        onClick={() =>
          void commit((p) => {
            const list: PlaybookDocument[] = p.documents ?? [];
            list.push({
              id: nextId('d', new Set(list.map((x) => x.id))),
              label: 'Will',
              location: 'where to find it',
            });
            p.documents = list;
          })
        }
      >
        + Add a document
      </button>
    </div>
  );
}
