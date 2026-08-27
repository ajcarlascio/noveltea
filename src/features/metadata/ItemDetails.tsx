import { useEffect, useId, useState } from "react";
import { useDatabase } from "@/app/db/DatabaseContext";
import {
  loadMetadataValues,
  setMetadataValue,
  type MetadataField,
  type MetadataValues,
} from "@/data/metadata";
import type { DatabaseClient } from "@/db/client";
import "./metadata.css";

/**
 * The selected item's answers to the project's custom fields.
 *
 * Renders nothing at all when the project has defined none, which is most projects:
 * an author who has never wanted a character sheet should not be paying for one in
 * manuscript height. The moment they define a field it appears here, under the label
 * and status the item already has.
 *
 * Values are read here rather than by `useBinder` because they are per item, and only
 * one item's worth is ever on screen. A cast of forty with a dozen fields is five
 * hundred rows to load on every keystroke's autosave otherwise.
 */
export function ItemDetails({
  projectId,
  fields,
  item,
  run,
}: {
  projectId: string;
  fields: readonly MetadataField[];
  /** The selected binder item, or null. */
  item: { id: string; title: string } | null;
  run: (action: (db: DatabaseClient) => Promise<unknown>) => Promise<void>;
}) {
  const { db } = useDatabase();
  const [values, setValues] = useState<MetadataValues>(() => new Map());
  const itemId = item?.id ?? null;

  useEffect(() => {
    if (itemId === null) {
      setValues(new Map());
      return;
    }
    let current = true;
    const refresh = () => {
      void loadMetadataValues(db, projectId, itemId).then(
        (loaded) => {
          if (current) setValues(loaded);
        },
        () => {
          // One unreadable answer is not a reason to blank the row the author is
          // looking at; the last good read stays on screen.
        },
      );
    };
    refresh();
    const stop = db.subscribeToChanges(refresh);
    return () => {
      current = false;
      stop();
    };
  }, [db, projectId, itemId]);

  if (fields.length === 0) return null;

  const save = (fieldId: string, value: unknown) => {
    if (itemId === null) return;
    void run((client) => setMetadataValue(client, projectId, itemId, fieldId, value));
  };

  return (
    <div className="details" aria-label="Details">
      {fields.map((field) => (
        <FieldValue
          key={field.id}
          field={field}
          value={values.get(field.id)}
          disabled={item === null}
          onSave={(value) => save(field.id, value)}
        />
      ))}
    </div>
  );
}

function FieldValue({
  field,
  value,
  disabled,
  onSave,
}: {
  field: MetadataField;
  value: unknown;
  disabled: boolean;
  onSave: (value: unknown) => void;
}) {
  const id = useId();

  return (
    <div className="details__field">
      {/* `htmlFor` rather than a wrapping label, for the same reason the label and
          status selects use it: a label wrapped around a select takes every option's
          text into its own accessible name. */}
      <label htmlFor={id}>{field.name}</label>
      <Control field={field} id={id} value={value} disabled={disabled} onSave={onSave} />
    </div>
  );
}

/**
 * One control, chosen by the field's kind.
 *
 * Native inputs throughout — `type="date"` opens the platform's own picker, and
 * `type="number"` gets the numeric keyboard on a phone. A date field is a calendar
 * date and not an instant, which is exactly what `<input type="date">` produces.
 *
 * A boolean is a three-way select rather than a checkbox. A checkbox cannot tell
 * "no" from "not asked yet", and for a field an author added to forty characters at
 * once that difference is the whole point.
 */
function Control({
  field,
  id,
  value,
  disabled,
  onSave,
}: {
  field: MetadataField;
  id: string;
  value: unknown;
  disabled: boolean;
  onSave: (value: unknown) => void;
}) {
  // Only the shapes a field's kind can produce. A stored object or array — from a
  // client that wrote this column differently — reads as not set rather than as
  // "[object Object]", which the author would otherwise save back as their answer.
  const stored =
    typeof value === "string"
      ? value
      : typeof value === "number" || typeof value === "boolean"
        ? String(value)
        : "";
  const [draft, setDraft] = useState(stored);
  const [editing, setEditing] = useState(false);
  // Follows the database except while this is the control being typed in.
  if (!editing && draft !== stored) setDraft(stored);

  if (field.type === "select" || field.type === "boolean") {
    const options =
      field.type === "boolean"
        ? [
            { value: "true", label: "Yes" },
            { value: "false", label: "No" },
          ]
        : field.options.map((option) => ({ value: option, label: option }));

    return (
      <select
        id={id}
        value={stored}
        disabled={disabled}
        onChange={(event) => {
          const next = event.target.value;
          if (next === "") return onSave(null);
          onSave(field.type === "boolean" ? next === "true" : next);
        }}
      >
        <option value="">Not set</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    );
  }

  // Saved on leaving the field, not per keystroke: each save is a queue entry the next
  // sync carries, and a name is retyped several times before it is right.
  const commit = () => {
    setEditing(false);
    const trimmed = draft.trim();
    if (trimmed === stored) return;
    if (trimmed === "") return onSave(null);
    if (field.type === "number") {
      const parsed = Number(trimmed);
      // Left on screen rather than sent: the command would refuse it, and the author
      // is mid-thought. An empty field is how they clear it.
      if (!Number.isFinite(parsed)) return;
      return onSave(parsed);
    }
    onSave(trimmed);
  };

  return (
    <input
      id={id}
      type={field.type === "number" ? "number" : field.type === "date" ? "date" : "text"}
      value={draft}
      disabled={disabled}
      onFocus={() => setEditing(true)}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
    />
  );
}
