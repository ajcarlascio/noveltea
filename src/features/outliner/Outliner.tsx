import { useCallback, useEffect, useMemo, useState } from "react";
import { useDatabase } from "@/app/db/DatabaseContext";
import {
  loadOutline,
  sortOutline,
  type OutlineRow,
  type Sort,
  type SortColumn,
} from "@/data/outline";
import { term, type Taxonomy } from "@/data/taxonomy";
import { DocumentIcon, FolderIcon } from "@/features/binder/icons";
import "./outliner.css";

/**
 * The binder as a table.
 *
 * The same data the corkboard shows, in the form you need when you are checking pace
 * across forty scenes rather than rearranging six: title, summary, label, status and
 * word count, all of it at once and sortable by any of them.
 *
 * Read-only apart from selecting a row. Editing a synopsis is what the corkboard is
 * for, and two editable views of one field is two places for a save to go wrong.
 */
export function Outliner({
  projectId,
  taxonomy,
  selectedId,
  onSelect,
}: {
  projectId: string;
  taxonomy: Taxonomy;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const { db } = useDatabase();
  const [rows, setRows] = useState<OutlineRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<Sort>(null);

  const reload = useCallback(() => {
    loadOutline(db, projectId).then(
      (loaded) => {
        setRows(loaded);
        setError(null);
      },
      (cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      },
    );
  }, [db, projectId]);

  useEffect(reload, [reload]);
  useEffect(() => db.subscribeToChanges(reload), [db, reload]);

  const name = useCallback(
    (id: string | null) => term(taxonomy, id)?.name ?? "",
    [taxonomy],
  );

  const shown = useMemo(() => sortOutline(rows ?? [], sort, name), [rows, sort, name]);

  if (error !== null) {
    return (
      <p className="outline__error" role="alert">
        {error}
      </p>
    );
  }

  if (rows !== null && rows.length === 0) {
    return <p className="outline__empty">Nothing in the binder yet.</p>;
  }

  return (
    <div className="outline">
      <table className="outline__table">
        <caption className="outline__caption">
          {sort === null
            ? "In manuscript order."
            : "Sorted, so this is a flat list rather than the shape of the book."}
        </caption>
        <thead>
          <tr>
            <Header column="title" sort={sort} onSort={setSort}>
              Title
            </Header>
            {/* Not sortable: alphabetising summaries answers no question anyone has. */}
            <th scope="col">Summary</th>
            <Header column="label" sort={sort} onSort={setSort}>
              Label
            </Header>
            <Header column="status" sort={sort} onSort={setSort}>
              Status
            </Header>
            <Header column="words" sort={sort} onSort={setSort} numeric>
              Words
            </Header>
          </tr>
        </thead>
        <tbody>
          {shown.map((row) => (
            <tr
              key={row.id}
              className="outline__row"
              aria-selected={row.id === selectedId}
              onClick={() => onSelect(row.id)}
            >
              <th scope="row" className="outline__title">
                <button type="button" className="outline__pick">
                  {/* Indented only in manuscript order. A sorted list is not the tree,
                      and indenting it would draw a hierarchy that is not being shown. */}
                  <span
                    className="outline__indent"
                    style={sort === null ? { paddingLeft: `${String(row.depth * 1.1)}rem` } : undefined}
                  >
                    <span className="outline__icon" aria-hidden="true">
                      {row.type === "folder" ? <FolderIcon /> : <DocumentIcon />}
                    </span>
                    {row.title}
                  </span>
                </button>
              </th>
              <td className="outline__synopsis">{row.synopsis ?? ""}</td>
              <td>{name(row.labelId)}</td>
              <td>{name(row.statusId)}</td>
              <td className="outline__words">{row.words.toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * A sortable column heading.
 *
 * Three states, cycled by clicking: ascending, descending, and back to manuscript order.
 * The third is not a nicety — without it there is no way back to the order the author
 * arranged the book in except reloading the page.
 */
function Header({
  column,
  sort,
  onSort,
  numeric,
  children,
}: {
  column: SortColumn;
  sort: Sort;
  onSort: (sort: Sort) => void;
  numeric?: boolean;
  children: React.ReactNode;
}) {
  const active = sort !== null && sort.column === column;
  const direction = !active ? "none" : sort.descending ? "descending" : "ascending";

  const next = (): Sort => {
    if (!active) return { column, descending: false };
    if (!sort.descending) return { column, descending: true };
    return null;
  };

  return (
    <th scope="col" aria-sort={direction} className={numeric ? "outline__numeric" : undefined}>
      <button type="button" className="outline__sort" onClick={() => onSort(next())}>
        {children}
        {/* Hidden from the accessibility tree: `aria-sort` on the header already says
            this, and a screen reader announcing both says it twice. */}
        <span className="outline__arrow" aria-hidden="true">
          {active ? (sort.descending ? "↓" : "↑") : ""}
        </span>
      </button>
    </th>
  );
}
