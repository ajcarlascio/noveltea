import { act, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DatabaseProvider } from "@/app/db/DatabaseProvider";
import { DatabaseClient } from "@/db/client";
import { fakeWorker } from "@/test/worker";
import { StorageWarning } from "../StorageWarning";

function renderWarning() {
  const fake = fakeWorker();
  const client = new DatabaseClient(fake.worker);
  render(
    <DatabaseProvider create={() => client}>
      <StorageWarning />
    </DatabaseProvider>,
  );
  return fake;
}

describe("StorageWarning", () => {
  it("says nothing while the database is still opening", () => {
    renderWarning();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("says nothing when the replica is persistent", () => {
    const fake = renderWarning();
    act(() =>
      fake.reply({ kind: "ready", storage: "opfs", appliedVersions: [], schemaVersion: 11 }),
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("warns, unmissably, when the replica is only in memory", () => {
    // This is the condition an author must never discover by losing a day's work.
    const fake = renderWarning();
    act(() =>
      fake.reply({ kind: "ready", storage: "memory", appliedVersions: [], schemaVersion: 11 }),
    );
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(/not storing your work/i);
    expect(alert).toHaveTextContent(/lost when you close this tab/i);
  });

  it("reports why the database could not be opened at all", () => {
    const fake = renderWarning();
    act(() =>
      fake.reply({ kind: "fatal", error: { name: "OpenError", message: "OPFS quota exceeded" } }),
    );
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(/could not be opened/i);
    // The cause is included: "something went wrong" gives an author nothing to act on.
    expect(alert).toHaveTextContent(/OPFS quota exceeded/);
  });
});
