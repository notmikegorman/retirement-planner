/**
 * The sidebar's module icons — one small stroke glyph per module, drawn
 * inline so the bundle needs no icon font and the glyphs inherit
 * currentColor (which is what keeps them legible in both themes and in the
 * active item's accent).
 */
import type { ReactNode } from 'react';
import type { Page } from '../nav';

function Glyph({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export const MODULE_ICONS: Record<Page, ReactNode> = {
  accounts: (
    <Glyph>
      <path d="M3 10h18M5 10v8m4.5-8v8m5-8v8M19 10v8M3 21h18M12 3l9 7H3l9-7z" />
    </Glyph>
  ),
  expenses: (
    <Glyph>
      <path d="M6 3h12v18l-2-1.5L14 21l-2-1.5L10 21l-2-1.5L6 21V3z" />
      <path d="M9 8h6M9 12h6" />
    </Glyph>
  ),
  home: (
    <Glyph>
      <path d="M3 11l9-7 9 7" />
      <path d="M5 10v10h14V10" />
    </Glyph>
  ),
  household: (
    <Glyph>
      <circle cx="9" cy="8" r="3" />
      <path d="M3.5 20c.5-3.5 2.7-5 5.5-5s5 1.5 5.5 5" />
      <circle cx="17" cy="9" r="2.4" />
      <path d="M15.8 15.2c2.6.2 4.3 1.6 4.7 4.8" />
    </Glyph>
  ),
  income: (
    <Glyph>
      <path d="M12 3v18" />
      <path d="M16.5 7c-1-1.2-2.6-1.8-4.5-1.8-2.4 0-4.2 1.2-4.2 3.1 0 4.3 9 2.3 9 6.6 0 1.9-1.8 3.2-4.8 3.2-2 0-3.8-.7-4.8-2" />
    </Glyph>
  ),
  insurance: (
    <Glyph>
      <path d="M12 3l7 3v5c0 5-3 8.5-7 10-4-1.5-7-5-7-10V6l7-3z" />
    </Glyph>
  ),
  investing: (
    <Glyph>
      <path d="M3 17l6-6 4 4 8-8" />
      <path d="M15 7h6v6" />
    </Glyph>
  ),
  networth: (
    <Glyph>
      <path d="M21 12A9 9 0 1 1 12 3" />
      <path d="M12 3a9 9 0 0 1 9 9h-9V3z" />
    </Glyph>
  ),
  search: (
    <Glyph>
      <circle cx="11" cy="11" r="6" />
      <path d="M20 20l-4.5-4.5" />
    </Glyph>
  ),
  settings: (
    <Glyph>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9L7 7M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1" />
    </Glyph>
  ),
  tithing: (
    <Glyph>
      <rect x="4" y="9" width="16" height="11" rx="1" />
      <path d="M12 9v11M4 14h16" />
      <path d="M12 9c-2 0-4-1-4-2.5C8 5 9 4 10.5 4 12 4 12 6 12 9zm0 0c2 0 4-1 4-2.5C16 5 15 4 13.5 4 12 4 12 6 12 9z" />
    </Glyph>
  ),
  workbench: (
    <Glyph>
      <path d="M4 6h16M4 12h16M4 18h16" />
      <circle cx="9" cy="6" r="2" />
      <circle cx="15" cy="12" r="2" />
      <circle cx="7" cy="18" r="2" />
    </Glyph>
  ),
};

/** The trashcan on every managed table row. */
export function TrashIcon() {
  return (
    <Glyph>
      <path d="M4 7h16M10 4h4M6.5 7l1 13h9l1-13M10 11v5M14 11v5" />
    </Glyph>
  );
}
