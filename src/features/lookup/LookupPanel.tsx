import type { Editor } from "@tiptap/react";
import { useState } from "react";
import { wordAtSelection } from "./selection";
import type { LookupKind } from "./types";
import { useLookup } from "./useLookup";
import "./LookupPanel.css";

const KIND_LABELS: Record<LookupKind, string> = {
  synonym: "Synonyms",
  related: "Related",
  rhyme: "Rhymes",
};

export function LookupPanel({ editor }: { editor: Editor | null }) {
  const { result, error, busy, kinds, look, clear } = useLookup();
  const [word, setWord] = useState("");

  if (kinds.length === 0) return null;

  const run = (kind: LookupKind) => {
    const term = word.trim() || wordAtSelection(editor);
    setWord(term);
    if (term.length > 0) look(term, kind);
  };

  return (
    <details className="lookup">
      <summary className="lookup__summary">Word lookup</summary>
      <div className="lookup__controls">
        <label className="lookup__field">
          <span className="lookup__label">Look up</span>
          <input
            value={word}
            placeholder="word under the cursor"
            onChange={(event) => setWord(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                run(kinds[0]!);
              }
            }}
          />
        </label>
        {kinds.map((kind) => (
          <button key={kind} type="button" className="button" onClick={() => run(kind)}>
            {KIND_LABELS[kind]}
          </button>
        ))}
      </div>

      {busy && <p className="lookup__status">Looking…</p>}

      {error !== null && (
        <p className="lookup__status lookup__status--error" role="alert">
          {error}
        </p>
      )}

      {result !== null && (
        <div className="lookup__results">
          <p className="lookup__source">
            {result.words.length === 0
              ? `Nothing found for “${result.word}”.`
              : `${KIND_LABELS[result.kind]} for “${result.word}”`}
            {" · "}
            {/* Stated on every result, so an author always knows which answers were
                private and which ones left the device. */}
            <span className={result.wasNetworked ? "lookup__networked" : "lookup__local"}>
              {result.wasNetworked ? `sent to ${result.source}` : `on this device · ${result.source}`}
            </span>
          </p>

          <ul className="lookup__words">
            {result.words.map((candidate) => (
              <li key={candidate}>
                <button
                  type="button"
                  className="lookup__word"
                  onClick={() => {
                    // Replaces the selection when there is one; otherwise inserts.
                    editor?.chain().focus().insertContent(candidate).run();
                    clear();
                  }}
                >
                  {candidate}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </details>
  );
}
