import { useEffect, useState } from "react";
import { startOfDay, type DayStart, type Goals } from "@/data/goals";
import { safeStorage } from "@/features/binder/binderState";
import "./goals.css";

/**
 * How much of the book exists, and how much of it happened today.
 *
 * One line, under the title, on every view — a target an author has to go looking for is
 * a target they stop noticing. Both numbers are counted from the replica rather than
 * from an event log, so deleting a chapter takes the count down. That is the honest
 * direction: a tally that only ever goes up stops being about the manuscript.
 */
export function ProgressStrip({
  projectId,
  words,
  goals,
}: {
  projectId: string;
  /** Null until the first read lands. */
  words: number | null;
  goals: Goals;
}) {
  const [day, setDay] = useState<DayStart | null>(null);

  useEffect(() => {
    // Deliberately not while `words` is null. The baseline is "the manuscript as it was
    // when today began", and recording it from the zero the strip shows before the first
    // read lands would credit the author with the entire book this morning.
    if (words === null) return;
    setDay(startOfDay(safeStorage(), projectId, words, new Date()));
  }, [projectId, words]);

  if (words === null) return null;

  const today = day === null ? 0 : words - day.words;

  return (
    <div className="goals" aria-label="Progress">
      <Count
        name="Today"
        value={today}
        {...(goals.dailyTarget === undefined ? {} : { target: goals.dailyTarget })}
      />
      <Count
        name="Manuscript"
        value={words}
        {...(goals.wordTarget === undefined ? {} : { target: goals.wordTarget })}
      />
    </div>
  );
}

const format = (value: number) => value.toLocaleString();

function Count({ name, value, target }: { name: string; value: number; target?: number }) {
  const reached = target !== undefined && value >= target;

  return (
    <span className="goals__count" data-reached={reached ? "true" : undefined}>
      <span className="goals__name">{name}</span>
      <span className="goals__value">
        {target === undefined
          ? `${format(value)} ${value === 1 ? "word" : "words"}`
          : `${format(value)} of ${format(target)}`}
      </span>
      {target !== undefined && (
        // The native element, so it is announced as a progress bar and needs no ARIA of
        // its own. Clamped at zero: a day that starts by cutting a chapter is a negative
        // number, which the text says plainly and a bar cannot draw.
        <progress className="goals__bar" value={Math.max(0, value)} max={target} />
      )}
    </span>
  );
}
