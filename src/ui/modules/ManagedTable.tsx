/**
 * THE TABLE STANDARD, in one component (the owner's rules, 2026-08-30):
 *
 *   - every column is sortable; the default sort is the FIRST column,
 *     ascending;
 *   - the first column is the primary one and looks clickable, and clicking
 *     anywhere on the row opens the record's detail;
 *   - every row carries a trashcan at the far right, behind a confirm modal.
 *
 * The Add button is deliberately NOT here — it lives in the module banner,
 * which is the standard's rule for it and the caller's slot to fill.
 *
 * Sorting compares each column's sortValue: two numbers numerically,
 * anything else as text (numeric-aware, so "line 10" sorts after "line 9").
 * The comparison never mutates the caller's array.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { ConfirmModal } from './ConfirmModal';
import { TrashIcon } from './icons';

export interface ManagedColumn<T> {
  key: string;
  label: string;
  /** What the column sorts by. */
  sortValue: (row: T) => string | number;
  /** What the cell shows; defaults to String(sortValue(row)). */
  render?: (row: T) => ReactNode;
  /** Numbers read right-aligned; everything else left. Default 'left'. */
  align?: 'left' | 'right';
}

export function ManagedTable<T>(props: {
  columns: ReadonlyArray<ManagedColumn<T>>;
  rows: readonly T[];
  rowId: (row: T) => string;
  onOpen: (row: T) => void;
  /** The trashcan's accessible name — "Delete 401(k)". */
  deleteLabel: (row: T) => string;
  /** The confirm modal's words for this row. */
  deleteConfirm: (row: T) => { title: string; body: string };
  onDelete: (row: T) => void;
  /** Optional tfoot content (totals line); exempt from sorting by nature. */
  foot?: ReactNode;
}) {
  const { columns, rows, rowId, onOpen, deleteLabel, deleteConfirm, onDelete, foot } = props;
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 }>({
    key: columns[0].key,
    dir: 1,
  });
  const [pendingDelete, setPendingDelete] = useState<T | null>(null);

  const sorted = useMemo(() => {
    const col = columns.find((c) => c.key === sort.key) ?? columns[0];
    return [...rows].sort((a, b) => {
      const va = col.sortValue(a);
      const vb = col.sortValue(b);
      const cmp =
        typeof va === 'number' && typeof vb === 'number'
          ? va - vb
          : String(va).localeCompare(String(vb), 'en', { numeric: true, sensitivity: 'base' });
      return cmp * sort.dir;
    });
  }, [columns, rows, sort]);

  const toggleSort = (key: string) => {
    setSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: 1 }));
  };

  return (
    <>
      <div className="table-scroll managedTableWrap">
        <table className="managedTable">
          <thead>
            <tr>
              {columns.map((c) => (
                <th
                  key={c.key}
                  className={c.align === 'right' ? undefined : 'col-text'}
                  aria-sort={
                    sort.key === c.key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'
                  }
                >
                  <button type="button" className="thSortBtn" onClick={() => toggleSort(c.key)}>
                    {c.label}
                    <span className="thSortMark" aria-hidden="true">
                      {sort.key === c.key ? (sort.dir === 1 ? '▲' : '▼') : ''}
                    </span>
                  </button>
                </th>
              ))}
              {/* The trashcan column: no heading, no sort — it is not data. */}
              <th className="deleteCell" />
            </tr>
          </thead>
          <tbody>
            {sorted.map((row) => (
              <tr key={rowId(row)} className="managedRow" onClick={() => onOpen(row)}>
                {columns.map((c, i) => (
                  <td key={c.key} className={c.align === 'right' ? undefined : 'col-text'}>
                    {i === 0 ? (
                      <button
                        type="button"
                        className="rowPrimaryBtn"
                        onClick={(e) => {
                          // The row's own onClick would fire too; one open.
                          e.stopPropagation();
                          onOpen(row);
                        }}
                      >
                        {c.render ? c.render(row) : String(c.sortValue(row))}
                      </button>
                    ) : c.render ? (
                      c.render(row)
                    ) : (
                      String(c.sortValue(row))
                    )}
                  </td>
                ))}
                <td className="deleteCell">
                  <button
                    type="button"
                    className="rowDeleteBtn"
                    aria-label={deleteLabel(row)}
                    title={deleteLabel(row)}
                    onClick={(e) => {
                      e.stopPropagation();
                      setPendingDelete(row);
                    }}
                  >
                    <TrashIcon />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
          {foot}
        </table>
      </div>
      {pendingDelete !== null ? (
        <ConfirmModal
          {...deleteConfirm(pendingDelete)}
          onConfirm={() => {
            onDelete(pendingDelete);
            setPendingDelete(null);
          }}
          onCancel={() => setPendingDelete(null)}
        />
      ) : null}
    </>
  );
}
