/**
 * The tab strip the form modules share (Tithing first, then Income, Household,
 * Home and Settings when the owner tabbed them all, 2026-08-30). These tabs are
 * LOCAL state, deliberately not in the URL: each module's tabs are views over
 * one editing surface (one draft, one Save commits them all), and the app's
 * rule keeps "where your hands are" out of the address bar — the same
 * reasoning as the Plan page's input panel (ScenarioPanel.tsx). Net worth's
 * strip is the URL-driven exception and renders its own.
 *
 * Rendered through ProfileFormModule's `tabs` slot, ABOVE and OUTSIDE the
 * view-mode fieldset — tabs are navigation, not edits, and must stay clickable
 * while the form is read-only.
 */
import type { ReactNode } from 'react';

export interface TabDef<T extends string> {
  readonly id: T;
  readonly label: string;
}

export function TabStrip<T extends string>(props: {
  /** Prefix for the tab/panel element ids (e.g. 'tithing'). */
  idPrefix: string;
  /** The strip's aria-label (e.g. 'Tithing views'). */
  label: string;
  tabs: ReadonlyArray<TabDef<T>>;
  active: T;
  onSelect: (id: T) => void;
}) {
  return (
    <nav className="modalTabBar" role="tablist" aria-label={props.label}>
      {props.tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          id={`${props.idPrefix}-tab-${t.id}`}
          aria-selected={props.active === t.id}
          aria-controls={`${props.idPrefix}-panel-${t.id}`}
          className={props.active === t.id ? 'modalTabBtn isActive' : 'modalTabBtn'}
          onClick={() => props.onSelect(t.id)}
        >
          {t.label}
        </button>
      ))}
    </nav>
  );
}

/** The panel half of the pair — wires the aria relationship TabStrip declares. */
export function TabPanel(props: { idPrefix: string; tab: string; children: ReactNode }) {
  return (
    <div
      role="tabpanel"
      id={`${props.idPrefix}-panel-${props.tab}`}
      aria-labelledby={`${props.idPrefix}-tab-${props.tab}`}
    >
      {props.children}
    </div>
  );
}
