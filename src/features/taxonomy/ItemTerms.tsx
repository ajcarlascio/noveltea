import { useId } from "react";
import { setItemTerms, type Taxonomy } from "@/data/taxonomy";
import type { DatabaseClient } from "@/db/client";
import "./taxonomy.css";

/**
 * The selected item's label and status, as two ordinary selects.
 *
 * Native `<select>`, not a bespoke menu: it is keyboard-navigable, it types-to-find,
 * and on a phone it opens the platform's own picker, which is a better control than
 * anything a manuscript app should be writing. The two are separate writes because
 * an author sets one at a time, and `setItemTaxonomy` leaves the field it was not
 * given alone.
 *
 * Rendered disabled rather than hidden when nothing is selected, matching the
 * toolbar buttons above it: a row that appears and disappears moves the manuscript
 * every time the author clicks a folder.
 */
export function ItemTerms({
  projectId,
  taxonomy,
  item,
  run,
}: {
  projectId: string;
  taxonomy: Taxonomy;
  /** The selected binder item, or null. */
  item: { id: string; title: string; labelId: string | null; statusId: string | null } | null;
  run: (action: (db: DatabaseClient) => Promise<unknown>) => Promise<void>;
}) {
  // `htmlFor`, not a wrapping <label>: a label that wraps a <select> takes every
  // option's text into its own accessible name, so the field ends up called
  // "Label No label Bob's POV" and nothing can address it by the word on screen.
  const labelField = useId();
  const statusField = useId();

  const set = (terms: { labelId?: string | null; statusId?: string | null }) => {
    if (item === null) return;
    void run((client) => setItemTerms(client, projectId, item.id, terms));
  };

  return (
    <div className="item-terms">
      <div className="item-terms__field">
        <label htmlFor={labelField}>Label</label>
        <select
          id={labelField}
          value={item?.labelId ?? ""}
          disabled={item === null}
          onChange={(event) => set({ labelId: event.target.value === "" ? null : event.target.value })}
        >
          <option value="">No label</option>
          {taxonomy.labels.map((label) => (
            <option key={label.id} value={label.id}>
              {label.name}
            </option>
          ))}
        </select>
      </div>

      <div className="item-terms__field">
        <label htmlFor={statusField}>Status</label>
        <select
          id={statusField}
          value={item?.statusId ?? ""}
          disabled={item === null}
          onChange={(event) =>
            set({ statusId: event.target.value === "" ? null : event.target.value })
          }
        >
          <option value="">No status</option>
          {taxonomy.statuses.map((status) => (
            <option key={status.id} value={status.id}>
              {status.name}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
