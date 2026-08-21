import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DatabaseClient } from "@/db/client";
import { DatabaseProvider } from "../DatabaseProvider";
import { useDatabase } from "../DatabaseContext";
import { fakeWorker } from "@/test/worker";

function Probe() {
  const { status } = useDatabase();
  return <output data-testid="state">{status.state}</output>;
}

function renderProvider() {
  const fake = fakeWorker();
  const client = new DatabaseClient(fake.worker);
  const view = render(
    <DatabaseProvider create={() => client}>
      <Probe />
    </DatabaseProvider>,
  );
  return { ...view, fake, client };
}

describe("DatabaseProvider", () => {
  it("renders children immediately rather than gating on the database", () => {
    // The replica is local. A full-screen spinner would be announcing a wait that
    // is not happening, and it would put the network's manners on local storage.
    renderProvider();
    expect(screen.getByTestId("state")).toHaveTextContent("opening");
  });

  it("follows the client's status", () => {
    const { fake } = renderProvider();
    // act() because the worker message reaches React from outside its event
    // system. React 18 still flushes such updates in the browser — this only
    // makes the flush deterministic for the assertion.
    act(() => fake.reply({ kind: "ready", storage: "opfs", appliedVersions: [], schemaVersion: 11 }));
    expect(screen.getByTestId("state")).toHaveTextContent("ready");
  });

  it("picks up a status that arrived before the effect subscribed", () => {
    // The client is constructed during render and the subscription happens in an
    // effect; a "ready" landing in between would otherwise be lost and the
    // provider would sit on "opening" forever.
    const fake = fakeWorker();
    const client = new DatabaseClient(fake.worker);
    fake.reply({ kind: "ready", storage: "opfs", appliedVersions: [], schemaVersion: 11 });

    render(
      <DatabaseProvider create={() => client}>
        <Probe />
      </DatabaseProvider>,
    );
    expect(screen.getByTestId("state")).toHaveTextContent("ready");
  });

  it("closes the database when it unmounts", () => {
    const { unmount, client, fake } = renderProvider();
    const close = vi.spyOn(client, "close");
    unmount();
    expect(close).toHaveBeenCalled();
    expect(fake.terminate).toHaveBeenCalled();
  });

  it("opens the database once, not on every render", () => {
    const fake = fakeWorker();
    const create = vi.fn(() => new DatabaseClient(fake.worker));
    const { rerender } = render(
      <DatabaseProvider create={create}>
        <Probe />
      </DatabaseProvider>,
    );
    rerender(
      <DatabaseProvider create={create}>
        <Probe />
      </DatabaseProvider>,
    );
    // A second call would open a second connection to the same OPFS file.
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe("useDatabase", () => {
  it("fails loudly outside a provider", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Probe />)).toThrow(/within <DatabaseProvider>/);
    consoleError.mockRestore();
  });
});
