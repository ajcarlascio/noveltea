import type { CompilePlan, CompileWarning } from "@noveltea/compile";
import "./PreflightNotice.css";

/**
 * What a compile would leave out, said before it runs.
 *
 * Two reasons this is worth the space. A long manuscript is expensive to render, and
 * finding out that half a selection was folders after waiting for it is finding out
 * too late. And silently converting something the author did not mean to publish — a
 * discarded scene, a note to themselves — is worse than saying so.
 *
 * The plan comes from the compile worker's own planner, run locally over the replica,
 * so this is not a guess about what the server will do.
 */

/** Grouped, because "6 empty documents" is readable and six lines of it is not. */
function group(warnings: CompileWarning[]): Map<string, CompileWarning[]> {
  const grouped = new Map<string, CompileWarning[]>();
  for (const warning of warnings) {
    grouped.set(warning.code, [...(grouped.get(warning.code) ?? []), warning]);
  }
  return grouped;
}

const HEADINGS: Record<string, (count: number) => string> = {
  excluded_trashed: (n) =>
    n === 1 ? "1 item is in the trash and will not be included" : `${String(n)} items are in the trash and will not be included`,
  empty_document: (n) =>
    n === 1 ? "1 document has no text yet" : `${String(n)} documents have no text yet`,
  not_convertible: (n) =>
    n === 1 ? "1 folder holds no text of its own" : `${String(n)} folders hold no text of their own`,
  notes_not_exported: () => "Synopses and notes are never exported",
  unsupported_node: (n) => `${String(n)} pieces of formatting will be simplified`,
  unsupported_mark: (n) => `${String(n)} pieces of formatting will be simplified`,
  unsafe_link: (n) => `${String(n)} links point somewhere unsafe and will be plain text`,
};

const heading = (code: string, count: number) =>
  (HEADINGS[code] ?? ((n: number) => `${String(n)} items need attention`))(count);

export function PreflightNotice({ plan }: { plan: CompilePlan | null }) {
  if (plan === null) return null;

  const grouped = group(plan.warnings);

  return (
    <div className="preflight">
      <p className="preflight__summary" role="status">
        {plan.included.length === 0
          ? "Nothing would be exported yet."
          : `${plan.included.length === 1 ? "1 document" : `${String(plan.included.length)} documents`}, ${String(plan.wordCount)} words.`}
      </p>

      {grouped.size > 0 && (
        <ul className="preflight__list">
          {[...grouped].map(([code, warnings]) => (
            <li key={code} className="preflight__group">
              <span className="preflight__heading">{heading(code, warnings.length)}</span>
              {/* The titles matter: "3 items are in the trash" is only reassuring if
                  the author can see it is not the chapter they meant to keep. */}
              {warnings.some((warning) => warning.itemTitle) && (
                <span className="preflight__items">
                  {warnings
                    .map((warning) => warning.itemTitle)
                    .filter((title): title is string => typeof title === "string")
                    .join(", ")}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
