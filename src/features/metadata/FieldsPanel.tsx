import { useId, useState } from "react";
import {
  createMetadataField,
  deleteMetadataField,
  updateMetadataField,
  type MetadataField,
} from "@/data/metadata";
import type { DatabaseClient } from "@/db/client";
import "./metadata.css";

/**
 * Defining the fields a project asks of its binder.
 *
 * This is the half that makes a character sheet possible without a second system for
 * character sheets: the author decides the questions — "Age", "Eyes", "First appears" —
 * and every folder and document can answer them.
 *
 * The **kind** is chosen once and cannot be changed afterwards. Every answer already
 * stored was checked against it, and there is no honest conversion: "yes" is not a
 * number and a date is not one of a list's choices. Changing it would leave answers
 * that pass no check and render as nothing, on every device at once.
 */
const KIND_LABELS: Record<string, string> = {
  text: "Text",
  number: "Number",
  date: "Date",
  boolean: "Yes or no",
  select: "A list of choices",
};

export function FieldsPanel({
  projectId,
  fields,
  run,
}: {
  projectId: string;
  fields: readonly MetadataField[];
  run: (action: (db: DatabaseClient) => Promise<unknown>) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState("text");
  const [choices, setChoices] = useState("");
  const kindField = useId();
  const choicesField = useId();

  const add = () => {
    const trimmed = name.trim();
    if (trimmed === "") return;
    setName("");
    setChoices("");
    void run((db) =>
      createMetadataField(
        db,
        projectId,
        trimmed,
        kind,
        kind === "select" ? splitChoices(choices) : undefined,
      ),
    );
  };

  return (
    <div className="fields">
      {fields.length === 0 ? (
        <p className="fields__empty">
          No fields yet. Add one and every folder and document can answer it — "Age" and
          "Eyes" for your cast, "First appears" for a place.
        </p>
      ) : (
        <ul className="fields__list">
          {fields.map((field) => (
            <li key={field.id} className="fields__item">
              <FieldRow projectId={projectId} field={field} run={run} />
            </li>
          ))}
        </ul>
      )}

      <form
        className="fields__add"
        onSubmit={(event) => {
          event.preventDefault();
          add();
        }}
      >
        <label className="fields__add-field">
          <span>New field</span>
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Eyes" />
        </label>

        <div className="fields__add-field">
          {/* "Kind of field", not "Kind": the collections panel on the same page also
              asks for a kind, and two different controls answering to one bare word is
              ambiguous for anyone driving this by voice or by screen reader — and for
              anything else addressing it by name. */}
          <label htmlFor={kindField}>Kind of field</label>
          <select id={kindField} value={kind} onChange={(event) => setKind(event.target.value)}>
            {Object.entries(KIND_LABELS).map(([value, text]) => (
              <option key={value} value={value}>
                {text}
              </option>
            ))}
          </select>
        </div>

        {kind === "select" && (
          <div className="fields__add-field">
            <label htmlFor={choicesField}>Choices</label>
            <input
              id={choicesField}
              value={choices}
              onChange={(event) => setChoices(event.target.value)}
              placeholder="Blue, Grey, Hazel"
            />
          </div>
        )}

        {/* Named for what it adds, for the same reason: the collections panel's own
            "Add" is a button away, and "Add" alone does not say which. */}
        <button
          type="submit"
          className="button"
          aria-label="Add field"
          disabled={name.trim() === ""}
        >
          Add
        </button>
      </form>
    </div>
  );
}

/** Commas, because a list of choices is a list an author writes as a list. */
function splitChoices(raw: string): string[] {
  return raw.split(",").map((choice) => choice.trim()).filter((choice) => choice.length > 0);
}

function FieldRow({
  projectId,
  field,
  run,
}: {
  projectId: string;
  field: MetadataField;
  run: (action: (db: DatabaseClient) => Promise<unknown>) => Promise<void>;
}) {
  const [name, setName] = useState(field.name);
  const [choices, setChoices] = useState(field.options.join(", "));
  const [editing, setEditing] = useState<"name" | "choices" | null>(null);
  const [confirming, setConfirming] = useState(false);

  // Each follows the stored value except while it is the one being typed in.
  if (editing !== "name" && name !== field.name) setName(field.name);
  const stored = field.options.join(", ");
  if (editing !== "choices" && choices !== stored) setChoices(stored);

  return (
    <div className="fields__row">
      <input
        className="fields__name"
        value={name}
        aria-label={`Name of ${field.name}`}
        onFocus={() => setEditing("name")}
        onChange={(event) => setName(event.target.value)}
        onBlur={() => {
          setEditing(null);
          const next = name.trim();
          if (next !== "" && next !== field.name) {
            void run((db) => updateMetadataField(db, projectId, field.id, { name: next }));
          }
        }}
      />
      <span className="fields__kind">{KIND_LABELS[field.type] ?? field.type}</span>

      {field.type === "select" && (
        <input
          className="fields__choices"
          value={choices}
          aria-label={`Choices for ${field.name}`}
          onFocus={() => setEditing("choices")}
          onChange={(event) => setChoices(event.target.value)}
          onBlur={() => {
            setEditing(null);
            const next = splitChoices(choices);
            if (next.length > 0 && next.join(", ") !== stored) {
              void run((db) => updateMetadataField(db, projectId, field.id, { options: next }));
            }
          }}
        />
      )}

      {confirming ? (
        <>
          <button
            type="button"
            className="button button--danger"
            onClick={() => {
              setConfirming(false);
              void run((db) => deleteMetadataField(db, projectId, field.id));
            }}
          >
            {`Delete ${field.name}`}
          </button>
          <button type="button" className="button" onClick={() => setConfirming(false)}>
            Keep
          </button>
        </>
      ) : (
        <button
          type="button"
          className="button"
          aria-label={`Delete ${field.name}`}
          onClick={() => setConfirming(true)}
        >
          Delete
        </button>
      )}
    </div>
  );
}
