/**
 * The banner across the top of every module — where titles and breadcrumbs
 * go, and where a module's actions live (the table's Add button, a detail's
 * Edit / Delete, an edit's Cancel / Save). One component so every module
 * wears identical chrome; the shell provides only the layout slot.
 *
 * The breadcrumb rule (the owner's, 2026-08-30): a table's detail adds a
 * crumb for the row, and the MAIN TITLE becomes clickable, returning to the
 * table. So with a crumb present the crumb is the page's h1 and the title
 * renders as a link; without one the title is the h1.
 */
import type { ReactNode } from 'react';

export function ModuleBanner(props: {
  title: string;
  /** Renders the title as a link back to wherever the caller says. */
  onTitleClick?: () => void;
  /** The record's name, shown after the title as the current crumb. */
  crumb?: ReactNode;
  /** A status pill beside the titles (e.g. Unsaved changes / Saved). */
  pill?: ReactNode;
  /** Right-aligned action buttons. */
  actions?: ReactNode;
}) {
  const { title, onTitleClick, crumb, pill, actions } = props;
  return (
    <header className="moduleBanner">
      <div className="moduleBannerTitles">
        {onTitleClick !== undefined ? (
          <button type="button" className="bannerTitleLink" onClick={onTitleClick}>
            {title}
          </button>
        ) : (
          <h1 className="bannerTitle">{title}</h1>
        )}
        {crumb !== undefined && crumb !== null ? (
          <>
            <span className="bannerCrumbSep" aria-hidden="true">
              /
            </span>
            <h1 className="bannerTitle bannerCrumb">{crumb}</h1>
          </>
        ) : null}
        {pill}
      </div>
      {actions !== undefined && actions !== null ? (
        <div className="moduleBannerActions">{actions}</div>
      ) : null}
    </header>
  );
}
