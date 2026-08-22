import { useCallback, useEffect, useState } from "react";
import { useDatabase } from "@/app/db/DatabaseContext";
import { search, type SearchHit } from "@/data/search";
import "./SearchPanel.css";

/**
 * Search across a project, from the local replica.
 *
 * Debounced rather than search-as-you-type-instantly: the query is local and fast,
 * but re-running it on every keystroke makes results flicker under the reader while
 * they are still typing the word.
 */
export function SearchPanel({
  projectId,
  onOpen,
}: {
  projectId: string;
  onOpen: (id: string) => void;
}) {
  const { db } = useDatabase();
  const [term, setTerm] = useState("");
  const [includeTrashed, setIncludeTrashed] = useState(false);
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    async (input: string, trashed: boolean) => {
      if (input.trim().length === 0) {
        setHits(null);
        return;
      }
      try {
        setHits(await search(db, projectId, input, { includeTrashed: trashed }));
        setError(null);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [db, projectId],
  );

  useEffect(() => {
    const timer = setTimeout(() => void run(term, includeTrashed), 200);
    return () => clearTimeout(timer);
  }, [term, includeTrashed, run]);

  // Re-run when anything is written locally. Without this, results are a snapshot of
  // the moment the search was typed: keep writing with a search open and the list
  // silently describes a version of the manuscript that no longer exists.
  useEffect(
    () => db.subscribeToChanges(() => void run(term, includeTrashed)),
    [db, run, term, includeTrashed],
  );

  return (
    <section className="search" aria-label="Search this project">
      <label className="search__field">
        <span className="search__label">Search</span>
        <input
          type="search"
          value={term}
          placeholder="a word, a &quot;phrase&quot;, or -exclude"
          onChange={(event) => setTerm(event.target.value)}
        />
      </label>

      <label className="search__option">
        <input
          type="checkbox"
          checked={includeTrashed}
          onChange={(event) => setIncludeTrashed(event.target.checked)}
        />
        <span>Include the trash</span>
      </label>

      {error !== null && (
        <p className="search__error" role="alert">
          {error}
        </p>
      )}

      {hits !== null && hits.length === 0 && (
        <p className="search__empty" role="status">
          Nothing matches “{term.trim()}”.
        </p>
      )}

      {hits !== null && hits.length > 0 && (
        <ul className="search__results">
          {hits.map((hit) => (
            <li key={hit.id}>
              <button
                type="button"
                className="search__hit"
                onClick={() => onOpen(hit.id)}
                disabled={hit.type === "folder"}
              >
                <span className="search__hit-title">
                  {hit.title}
                  {hit.trashed && <span className="search__badge">in the trash</span>}
                </span>
                {hit.snippet.length > 0 && (
                  <span className="search__snippet">{hit.snippet}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
