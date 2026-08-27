import { term, type Taxonomy } from "@/data/taxonomy";
import "./taxonomy.css";

/**
 * What a label and a status look like wherever an item is drawn.
 *
 * One component for the binder row and the index card, because they have to agree:
 * an author sets a label in one view and looks for it in the other, and two spellings
 * of "coloured dot" is how they end up disagreeing about which is which.
 *
 * The label is a dot *and* its name, not the name in colour. Colour alone is not
 * information a screen reader or a colour-blind reader receives, and an outline of
 * twelve names in twelve hues stops being readable at all.
 *
 * `compact` is the binder's version, where the row is fifteen rems wide and shared
 * with a chapter title that matters more: the dot alone, with the name still there
 * for a screen reader and in the tooltip. The card has room for the words.
 */
export function TermMarks({
  taxonomy,
  labelId,
  statusId,
  compact = false,
}: {
  taxonomy: Taxonomy;
  labelId: string | null;
  statusId: string | null;
  compact?: boolean;
}) {
  const label = term(taxonomy, labelId);
  const status = term(taxonomy, statusId);
  if (label === null && status === null) return null;

  return (
    <>
      {label !== null && (
        <span className="term-mark term-mark--label" title={label.name}>
          <span
            className="term-mark__dot"
            aria-hidden="true"
            // Inline because the colour is the author's, chosen at runtime; there is
            // no stylesheet that could know it. Falls back to the border token so a
            // label saved without one is still visible.
            style={{ background: label.color ?? "var(--border-strong)" }}
          />
          <span className={compact ? "term-mark__name--hidden" : undefined}>{label.name}</span>
        </span>
      )}
      {status !== null && (
        <span
          className={`term-mark term-mark--status${compact ? " term-mark--dim" : ""}`}
          title={status.name}
        >
          {/* Abbreviated rather than dropped in the binder: "how far along is this"
              is half of what an outline is read for, and an initial the tooltip and
              the screen reader both expand is enough to scan a chapter list by. The
              initial is hidden from the screen reader, which gets the whole word —
              hearing "F, First draft" on every row is worse than hearing neither. */}
          {compact ? (
            <>
              <span aria-hidden="true">{status.name.slice(0, 1).toUpperCase()}</span>
              <span className="term-mark__name--hidden">{status.name}</span>
            </>
          ) : (
            status.name
          )}
        </span>
      )}
    </>
  );
}
