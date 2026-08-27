import { useId, useState } from "react";
import { saveGoals, type Goals } from "@/data/goals";
import type { DatabaseClient } from "@/db/client";
import "./goals.css";

/**
 * Setting the two targets.
 *
 * An empty box clears the target rather than storing a zero, so "no target" is the
 * absence of one and the strip above has no special case to get wrong.
 *
 * These live in `project.settings` and do not sync yet — `pending_change` has no
 * `project` entity type, because the sync endpoint is scoped by a project id in its path
 * and cannot carry a change to the project row. Said out loud in the panel rather than
 * left for an author to discover on their second machine.
 */
export function TargetsPanel({
  projectId,
  goals,
  run,
}: {
  projectId: string;
  goals: Goals;
  run: (action: (db: DatabaseClient) => Promise<unknown>) => Promise<void>;
}) {
  return (
    <div className="targets">
      <Target
        projectId={projectId}
        name="Words in the finished manuscript"
        field="wordTarget"
        value={goals.wordTarget}
        placeholder="80000"
        run={run}
      />
      <Target
        projectId={projectId}
        name="Words a day"
        field="dailyTarget"
        value={goals.dailyTarget}
        placeholder="1000"
        run={run}
      />
      <p className="targets__note">
        Targets and today's count stay on this device. The manuscript itself syncs; the
        project's own row does not travel through the change feed yet.
      </p>
    </div>
  );
}

function Target({
  projectId,
  name,
  field,
  value,
  placeholder,
  run,
}: {
  projectId: string;
  name: string;
  field: "wordTarget" | "dailyTarget";
  value: number | undefined;
  placeholder: string;
  run: (action: (db: DatabaseClient) => Promise<unknown>) => Promise<void>;
}) {
  const id = useId();
  const stored = value === undefined ? "" : String(value);
  const [draft, setDraft] = useState(stored);
  const [editing, setEditing] = useState(false);
  if (!editing && draft !== stored) setDraft(stored);

  return (
    <div className="targets__field">
      <label htmlFor={id}>{name}</label>
      <input
        id={id}
        type="number"
        min="1"
        value={draft}
        placeholder={placeholder}
        onFocus={() => setEditing(true)}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          setEditing(false);
          const trimmed = draft.trim();
          if (trimmed === stored) return;
          if (trimmed === "") {
            return void run((db) => saveGoals(db, projectId, { [field]: null }));
          }
          const parsed = Number(trimmed);
          // Left on screen rather than sent. A half-typed number is not a mistake worth
          // an error message, and an empty box is how a target is cleared.
          if (!Number.isInteger(parsed) || parsed <= 0) return;
          void run((db) => saveGoals(db, projectId, { [field]: parsed }));
        }}
      />
    </div>
  );
}
