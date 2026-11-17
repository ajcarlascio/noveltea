import { useRef, useState } from "react";

/**
 * The text of a field that is saved when the author leaves it.
 *
 * Every such field follows its stored value, so a change from another device shows up,
 * except while it is the one being typed in. The trap is in what "changed" means when
 * the author leaves: compared with what is stored *now*, a field that was only clicked
 * into looks edited whenever the stored value moved underneath it, and leaving it sends
 * the old value back over the new one. So the comparison is with what was there when
 * the author entered the field. `leave` returns their text if they changed it, and null
 * if they did not, in which case the field goes back to following the stored value.
 *
 * A field the author did rewrite is saved as usual. For everything but a document the
 * server keeps the last write, which is then the one somebody meant.
 */
export function useFieldDraft(stored: string): {
  draft: string;
  setDraft: (next: string) => void;
  editing: boolean;
  enter: () => void;
  leave: () => string | null;
} {
  const [draft, setDraft] = useState(stored);
  const [editing, setEditing] = useState(false);
  const entered = useRef(stored);
  if (!editing && draft !== stored) setDraft(stored);

  return {
    draft,
    setDraft,
    editing,
    enter: () => {
      entered.current = stored;
      setEditing(true);
    },
    leave: () => {
      setEditing(false);
      return draft === entered.current ? null : draft;
    },
  };
}
