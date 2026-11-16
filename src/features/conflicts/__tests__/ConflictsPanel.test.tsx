import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DatabaseContext } from "@/app/db/DatabaseContext";
import type { DatabaseClient, DbStatus } from "@/db/client";
import { AuthProvider } from "@/features/auth/AuthProvider";
import type { Session } from "@/features/auth/session";
import { ConflictsPanel } from "../ConflictsPanel";

const SESSION: Session = {
  serverUrl: "https://write.example.test",
  userId: "u1",
  deviceId: "d1",
  refreshToken: "r",
  email: "author@example.com",
};

const summary = {
  copyId: "c1",
  originalId: "o1",
  originalTitle: "Chapter One",
  copyTitle: "Chapter One (Conflicted Copy, Laptop)",
  forkedFromVersion: 4,
  originalVersion: 7,
  forkedAt: "2026-02-01T10:00:00Z",
};

const doc = (text: string) => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

const detail = {
  ...summary,
  originalContent: doc("the lighthouse kept its own hours"),
  copyContent: doc("the lighthouse kept nobody's hours"),
};

/** A replica that reports how many conflict copies it holds, and tells when it changes. */
function fakeReplica() {
  const listeners = new Set<() => void>();
  const state = { copies: 0 };
  const db = {
    query: () => Promise.resolve([{ n: state.copies }]),
    subscribeToChanges: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as DatabaseClient;
  return {
    db,
    /** A sync wrote something; `copies` is how many conflict copies are there now. */
    change: (copies: number) => {
      state.copies = copies;
      for (const listener of listeners) listener();
    },
  };
}

const READY: DbStatus = { state: "ready", storage: "memory", appliedVersions: [], schemaVersion: 11 };

function renderPanel(
  handler: (path: string, init?: RequestInit) => Promise<Response>,
  session: Session | null = SESSION,
  replica = fakeReplica(),
  onReview?: () => void,
) {
  const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    // The authenticator has no access token yet, so its very first act is to refresh.
    // Answering that with a conflict list makes every request after it fail.
    if (url.includes("/auth/refresh")) {
      return ok({ userId: "u1", deviceId: "d1", accessToken: "a", refreshToken: "r", expiresIn: 900 });
    }
    return handler(url, init);
  });
  render(
    <DatabaseContext.Provider value={{ db: replica.db, status: READY }}>
      <AuthProvider initialSession={session} fetcher={fetcher}>
        <ConflictsPanel projectId="p1" {...(onReview && { onReview })} />
      </AuthProvider>
    </DatabaseContext.Provider>,
  );
  return fetcher;
}

function bodyOf(init: RequestInit | undefined): unknown {
  const body = init?.body;
  return typeof body === "string" ? JSON.parse(body) : null;
}

const ok = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));

describe("when there is nothing to resolve", () => {
  it("shows nothing at all", async () => {
    renderPanel(() => ok([]));
    // An empty panel headed "Conflicts" is a permanent reminder of a problem that does
    // not exist.
    await waitFor(() => {
      expect(screen.queryByRole("region", { name: "Conflicts" })).not.toBeInTheDocument();
    });
  });

  it("shows nothing when signed out, because conflicts need two devices", async () => {
    const fetcher = renderPanel(() => ok([summary]), null);
    await waitFor(() => {
      expect(screen.queryByRole("region", { name: "Conflicts" })).not.toBeInTheDocument();
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("listing", () => {
  it("says what happened in words an author can act on", async () => {
    renderPanel(() => ok([summary]));

    expect(await screen.findByText(/one document needs your attention/i)).toBeInTheDocument();
    // The reassurance matters as much as the warning: the design guarantees nothing
    // was lost, and an author seeing "conflict" assumes the opposite.
    expect(screen.getByText(/nothing was overwritten/i)).toBeInTheDocument();
    expect(screen.getByText("Chapter One")).toBeInTheDocument();
  });

  it("counts more than one", async () => {
    renderPanel(() => ok([summary, { ...summary, copyId: "c2" }]));
    expect(await screen.findByText(/2 documents need your attention/i)).toBeInTheDocument();
  });
});

describe("reviewing a pair", () => {
  const handler = (path: string) =>
    path.includes("/conflicts/c1") ? ok(detail) : ok([summary]);

  it("shows both versions with their provenance", async () => {
    renderPanel(handler);
    await userEvent.click(await screen.findByRole("button", { name: "Review" }));

    expect(await screen.findByRole("region", { name: "Resolve a conflict" })).toBeInTheDocument();
    expect(screen.getByText(/version 7/)).toBeInTheDocument();
    expect(screen.getByText(/forked at version 4/)).toBeInTheDocument();
    expect(screen.getByText(/kept its own hours/)).toBeInTheDocument();
    expect(screen.getByText(/kept nobody's hours/)).toBeInTheDocument();
  });

  it("will not resolve until the author has chosen a starting point", async () => {
    renderPanel(handler);
    await userEvent.click(await screen.findByRole("button", { name: "Review" }));

    // Resolving nothing would replace the document with an empty one.
    expect(await screen.findByRole("button", { name: "Resolve" })).toBeDisabled();

    await userEvent.click(screen.getAllByRole("button", { name: "Start from this" })[0]!);
    expect(screen.getByRole("button", { name: "Resolve" })).toBeEnabled();
  });

  it("sends the merged text with the original document's version", async () => {
    const sent: { path: string; body: unknown }[] = [];
    const fetcher = renderPanel((path, init) => {
      if (init?.method === "POST") {
        sent.push({ path, body: bodyOf(init) });
        return ok({});
      }
      return path.includes("/conflicts/c1") ? ok(detail) : ok([summary]);
    });

    await userEvent.click(await screen.findByRole("button", { name: "Review" }));
    await userEvent.click(screen.getAllByRole("button", { name: "Start from this" })[0]!);
    await userEvent.click(screen.getByRole("button", { name: "Resolve" }));

    await waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    expect(sent[0]?.path).toContain("/api/v1/conflicts/c1/resolve");
    // The document's version. The binder item carries its own for structural edits,
    // and sending that one can never match.
    expect(sent[0]?.body).toMatchObject({ baseVersion: 7 });
    expect(fetcher).toHaveBeenCalled();
  });

  it("keeps the merge on screen when the server says it went stale", async () => {
    renderPanel((path, init) => {
      if (init?.method === "POST") {
        return Promise.resolve(
          new Response(JSON.stringify({ code: "stale_original" }), { status: 409 }),
        );
      }
      return path.includes("/conflicts/c1") ? ok(detail) : ok([summary]);
    });

    await userEvent.click(await screen.findByRole("button", { name: "Review" }));
    await userEvent.click(screen.getAllByRole("button", { name: "Start from this" })[0]!);
    await userEvent.click(screen.getByRole("button", { name: "Resolve" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/nothing was lost/i);
    // Closing the view here would throw away the merge the author just built, which is
    // the one thing worse than making them do it again.
    expect(screen.getByRole("region", { name: "Resolve a conflict" })).toBeInTheDocument();
  });

  it("lets the author walk away without resolving", async () => {
    renderPanel(handler);
    await userEvent.click(await screen.findByRole("button", { name: "Review" }));
    await userEvent.click(await screen.findByRole("button", { name: /leave it for now/i }));

    // A conflict is not an emergency: the words are safe in both places.
    expect(await screen.findByText("Chapter One")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Resolve a conflict" })).not.toBeInTheDocument();
  });
});

describe("during a session", () => {
  it("lists a copy that a sync made after the panel mounted, without a reload", async () => {
    const replica = fakeReplica();
    let listed: unknown[] = [];
    renderPanel(() => ok(listed), SESSION, replica);
    await waitFor(() => expect(screen.queryByRole("region", { name: "Conflicts" })).not.toBeInTheDocument());

    listed = [summary];
    await act(async () => {
      replica.change(1);
      await Promise.resolve();
    });

    expect(await screen.findByText(/one document needs your attention/i)).toBeInTheDocument();
  });

  it("does not ask the server again for a change that is not a conflict copy", async () => {
    const replica = fakeReplica();
    const fetcher = renderPanel(() => ok([]), SESSION, replica);
    await waitFor(() => expect(fetcher).toHaveBeenCalled());
    const before = fetcher.mock.calls.length;

    await act(async () => {
      replica.change(0); // an autosave, say
      await Promise.resolve();
    });

    expect(fetcher).toHaveBeenCalledTimes(before);
  });

  it("says when the author opens one, so the sync notice can stand down", async () => {
    const onReview = vi.fn();
    renderPanel((path) => (path.includes("/conflicts/c1") ? ok(detail) : ok([summary])), SESSION, fakeReplica(), onReview);

    await userEvent.click(await screen.findByRole("button", { name: "Review" }));

    expect(onReview).toHaveBeenCalledTimes(1);
  });
});
