/**
 * The boot-gate PAGES: the first-visit storage question, the returning
 * folder user's reconnect click, the no-picker fallback banner (D8), and —
 * since zero-start — the first-run SETUP step (ProfileSetup below).
 * main.tsx renders exactly one of these instead of the app whenever
 * computeBootGate() says the boot cannot proceed on its own — always
 * because the next step legally requires a user gesture (the picker, the
 * permission re-grant, the household answer), never as decoration.
 *
 * The WORDS carry the design. Every claim on these screens is one the code
 * keeps: the folder option really is plain JSON files the owner can read
 * and back up; demo storage really does vanish with Clear browsing data;
 * simulations really do run on this machine only.
 *
 * ONE QUESTION, ONE ANSWER (2026-08-29, DECISIONS.md "The chooser loses its
 * second answer"): on a picker-capable browser the chooser offers exactly
 * one storage action — pick a folder. The browser-private (OPFS) card the
 * owner was greeted with on his first real test-drive is gone; no visible
 * UI on such a browser writes the 'opfs' choice any more (the walkthrough
 * lane pins this). OPFS itself stays fully alive underneath: the no-picker
 * fallback below is Safari/Firefox's only door (D8, unchanged), and a
 * remembered 'opfs' choice — anyone who picked browser-private storage
 * while it was offered, or a test lane seeding the choice — still boots
 * straight in (storageChoice.ts owns that rule).
 */
import { useState, type CSSProperties } from 'react';
import type { Profile, StateCode } from '../../shared/types';
import {
  buildInitialProfile,
  validateSetupInput,
  type SetupInput,
  type SetupPerson,
} from '../../shared/setupProfile';
import { CheckboxField, NumberField, SelectField, TextField } from '../components/profile/fields';
import { MONTH_NAMES, STATE_LABELS } from '../components/profile/profileLogic';
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

  /** D8's only door — rendered ONLY when this browser has no folder picker. */
  function tryDemoStorage(): void {
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
        <>
          <div className="warn-banner" role="status">
            This browser can&apos;t hold a durable folder connection — the folder picker (the
            File System Access API) ships in Chrome, Edge, and Brave. You can still explore the
            whole app in browser-private demo storage below; for real, file-backed use, open
            this page in one of those browsers.
          </div>
          <div className="card">
            <h2 style={{ marginTop: 0 }}>Browser-private demo storage</h2>
            <p className="muted">
              No picker and no prompts: the files live inside this browser profile, invisible on
              disk. It opens on a filled-in example household so there is something to see.
              Good for trying the app — but Clear browsing data erases everything, and no
              ordinary backup ever sees it.
            </p>
            <button className="primary" onClick={tryDemoStorage}>
              Try it in demo storage
            </button>
          </div>
        </>
      ) : (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>A folder on this computer</h2>
          <p className="muted">
            Your profile, plan, and net-worth ledger live as plain JSON files in a folder you
            pick — readable, diffable, and yours to back up (copy it, git it, sync it). Pick an
            empty folder to start fresh — the app asks for the few facts it needs and everything
            you then see is your own data — or pick a folder that already holds planner data to
            open it.
          </p>
          <button className="primary" onClick={() => void pickFolder()}>
            Pick a folder…
          </button>
        </div>
      )}

      {error !== null ? <div className="error-banner">Could not use that folder: {error}</div> : null}

      <p className="muted">
        {canPickFolder
          ? 'Whichever folder you pick: simulations run on this machine, and your data never leaves it.'
          : 'Either way: simulations run on this machine, and your data never leaves it.'}
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

// ---------------------------------------------------------------------------
// The first-run setup step (zero-start)
// ---------------------------------------------------------------------------

/**
 * ONE page, asking only what the tax and Social Security engine cannot run
 * without: who (name + birth month/year, optionally a second person) and
 * which supported state. Filing status is derived — one person files single,
 * two file jointly — so it is stated, not asked.
 *
 * NOTHING IS WRITTEN UNTIL SUBMIT. The submit builds the minimal valid
 * profile (shared/setupProfile.ts) and hands it to `onSubmit`, which main.tsx
 * wires to api.putProfile — the ordinary store path, behind the writer guard
 * the boot already holds. Abandoning this page and reloading therefore lands
 * back here, with nothing half-written anywhere.
 */
const UNPICKED_MONTH = '0';

const MONTH_OPTIONS = [
  { value: UNPICKED_MONTH, label: 'pick a month…' },
  ...MONTH_NAMES.map((name, i) => ({ value: String(i + 1), label: name })),
];

const STATE_OPTIONS = (Object.keys(STATE_LABELS) as StateCode[]).map((value) => ({
  value,
  label: STATE_LABELS[value],
}));

interface PersonDraft {
  name: string;
  birthYear: number | undefined;
  /** As the <select> holds it; '0' is the deliberate "not picked yet". */
  birthMonth: string;
}

const emptyPerson = (): PersonDraft => ({ name: '', birthYear: undefined, birthMonth: UNPICKED_MONTH });

/** The draft as the validator/builder wants it; unfilled numbers become 0 so the validator names them. */
function draftToSetupPerson(draft: PersonDraft): SetupPerson {
  return {
    name: draft.name,
    birthYear: draft.birthYear ?? 0,
    birthMonth: Number(draft.birthMonth),
  };
}

function PersonFields({
  draft,
  nameLabel,
  onChange,
}: {
  draft: PersonDraft;
  nameLabel: string;
  onChange: (next: PersonDraft) => void;
}) {
  return (
    <div className="row">
      <TextField
        label={nameLabel}
        value={draft.name}
        width={200}
        onCommit={(v) => onChange({ ...draft, name: v })}
      />
      <NumberField
        label="Birth year"
        int
        value={draft.birthYear}
        width={110}
        placeholder="e.g. 1975"
        allowEmpty
        onCommit={(v) => onChange({ ...draft, birthYear: v })}
      />
      <SelectField
        label="Birth month"
        value={draft.birthMonth}
        options={MONTH_OPTIONS}
        width={150}
        onChange={(v) => onChange({ ...draft, birthMonth: v })}
      />
    </div>
  );
}

export function ProfileSetup({ onSubmit }: { onSubmit: (profile: Profile) => Promise<void> }) {
  const [person1, setPerson1] = useState<PersonDraft>(emptyPerson);
  const [couple, setCouple] = useState(false);
  const [person2, setPerson2] = useState<PersonDraft>(emptyPerson);
  const [state, setState] = useState<StateCode>('va');
  const [problems, setProblems] = useState<string[]>([]);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(): Promise<void> {
    const input: SetupInput = {
      person1: draftToSetupPerson(person1),
      person2: couple ? draftToSetupPerson(person2) : null,
      state,
      year: new Date().getFullYear(),
    };
    const found = validateSetupInput(input);
    setProblems(found);
    if (found.length > 0) return;
    setWriteError(null);
    setSaving(true);
    try {
      await onSubmit(buildInitialProfile(input));
    } catch (err) {
      setWriteError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  }

  return (
    <div style={shell}>
      <h1>Who is this plan for?</h1>
      <p>
        This planner starts from zero: everything it will show you is your own data. These are
        the only facts the tax and Social Security engine cannot run without — everything else
        (accounts, income, expenses) is added inside, where each number explains itself.
      </p>

      <div className="card">
        <PersonFields draft={person1} nameLabel="Your name" onChange={setPerson1} />
        <CheckboxField
          label="Planning for two — add a second person"
          checked={couple}
          onChange={setCouple}
        />
        {couple ? (
          <PersonFields draft={person2} nameLabel="Their name" onChange={setPerson2} />
        ) : null}
        <div className="row" style={{ marginTop: 8 }}>
          <SelectField
            label="State"
            value={state}
            options={STATE_OPTIONS}
            width={180}
            help="Drives the state income-tax module — these three states are the ones the app models"
            onChange={(v) => setState(v as StateCode)}
          />
        </div>
        <div className="field-help" style={{ marginTop: 4 }}>
          Filing status follows from the people: two file jointly (MFJ), one files single. A
          survivor&rsquo;s single filing is modeled per simulated year, never set here.
        </div>
        {problems.length > 0 ? (
          <div className="error-banner" role="alert" style={{ marginTop: 12 }}>
            {problems.map((p) => (
              <div key={p}>{p}</div>
            ))}
          </div>
        ) : null}
        {writeError !== null ? (
          <div className="error-banner" role="alert" style={{ marginTop: 12 }}>
            Could not write the profile: {writeError}
          </div>
        ) : null}
        <div style={{ marginTop: 12 }}>
          <button className="primary" disabled={saving} onClick={() => void submit()}>
            {saving ? 'Writing your profile…' : 'Start with this household'}
          </button>
        </div>
      </div>

      <p className="muted">
        Nothing is saved until you press the button — reloading before then brings you back
        here. Afterward, add your accounts on the Accounts page: the simulation starts when there
        is something to simulate.
      </p>
    </div>
  );
}

export { supportsFolderPicker };
