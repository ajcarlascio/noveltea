import { describe, expect, it } from "vitest";
import type { Authenticator } from "@/features/auth/authenticate";
import { listConflicts, loadConflict, ResolveRejected, resolveConflict } from "../api";

function fakeAuth(handler: (path: string, init?: RequestInit) => Promise<Response>) {
  const calls: { path: string; init?: RequestInit }[] = [];
  const auth = {
    accessToken: () => Promise.resolve("t"),
    fetch: (path: string, init?: RequestInit) => {
      calls.push({ path, ...(init ? { init } : {}) });
      return handler(path, init);
    },
    onRotate: () => undefined,
    onExpired: () => undefined,
  } as unknown as Authenticator;
  return { auth, calls };
}

/** Awaits a rejection and hands it back typed; tsc cannot narrow a catch. */
async function rejection(promise: Promise<unknown>): Promise<ResolveRejected> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ResolveRejected) return error;
    throw error;
  }
  throw new Error("expected the call to fail, and it did not");
}

/** The JSON body a recorded call carried. */
function bodyOf(init: RequestInit | undefined): unknown {
  const body = init?.body;
  return typeof body === "string" ? JSON.parse(body) : null;
}

const ok = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
const fail = (status: number, body: unknown = {}) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

const summary = {
  copyId: "c1",
  originalId: "o1",
  originalTitle: "Chapter One",
  copyTitle: "Chapter One (Conflicted Copy, Laptop, 2026-02-01)",
  forkedFromVersion: 4,
  originalVersion: 7,
  forkedAt: "2026-02-01T10:00:00Z",
};

describe("listing", () => {
  it("reads the conflicts a project has", async () => {
    const { auth, calls } = fakeAuth(() => ok([summary]));
    await expect(listConflicts(auth, "p1")).resolves.toEqual([summary]);
    expect(calls[0]?.path).toBe("/api/v1/projects/p1/conflicts");
  });

  it("drops an entry that names neither document", async () => {
    // Without both ids there is nothing to open and nothing to resolve; showing it
    // would offer the author a row that cannot do anything.
    const { auth } = fakeAuth(() => ok([summary, { copyId: "c2" }, null, "x"]));
    await expect(listConflicts(auth, "p1")).resolves.toHaveLength(1);
  });

  it("returns nothing rather than failing when there are none", async () => {
    const { auth } = fakeAuth(() => ok([]));
    await expect(listConflicts(auth, "p1")).resolves.toEqual([]);
  });

  it("fills in a missing title rather than showing a blank row", async () => {
    const { auth } = fakeAuth(() => ok([{ copyId: "c1", originalId: "o1" }]));
    const [row] = await listConflicts(auth, "p1");
    expect(row?.originalTitle).toBe("Untitled");
    expect(row?.copyTitle).toBe("Conflicted copy");
  });
});

describe("loading a pair", () => {
  it("returns both documents and their provenance", async () => {
    const { auth } = fakeAuth(() =>
      ok({ ...summary, originalContent: { type: "doc" }, copyContent: { type: "doc" } }),
    );
    const detail = await loadConflict(auth, "c1");
    expect(detail.originalContent).toEqual({ type: "doc" });
    expect(detail.copyContent).toEqual({ type: "doc" });
    expect(detail.forkedFromVersion).toBe(4);
    expect(detail.originalVersion).toBe(7);
  });

  it("treats content that is not a document as absent", async () => {
    const { auth } = fakeAuth(() => ok({ ...summary, originalContent: "oops", copyContent: 3 }));
    const detail = await loadConflict(auth, "c1");
    expect(detail.originalContent).toBeNull();
    expect(detail.copyContent).toBeNull();
  });

  it("refuses a response it cannot make sense of", async () => {
    const { auth } = fakeAuth(() => ok({ nope: true }));
    await expect(loadConflict(auth, "c1")).rejects.toThrow(/does not understand/i);
  });
});

describe("resolving", () => {
  it("sends the reconciled text with the original document's version", async () => {
    const { auth, calls } = fakeAuth(() => ok({}));
    const merged = { type: "doc", content: [{ type: "paragraph" }] };

    await resolveConflict(auth, "c1", merged, 7);

    expect(calls[0]?.path).toBe("/api/v1/conflicts/c1/resolve");
    // The document's version, not the binder item's. The binder item carries its own
    // for structural edits, and sending that one can never match.
    expect(bodyOf(calls[0]?.init)).toEqual({ content: merged, baseVersion: 7 });
  });

  it("reports a stale merge as something to redo, not as a failure", async () => {
    // The server refuses rather than forking again; forking on merge would let copies
    // breed without bound.
    const { auth } = fakeAuth(() => fail(409, { code: "stale_document" }));
    const error = await rejection(resolveConflict(auth, "c1", {}, 7));

    expect(error.stale).toBe(true);
    expect(error.message).toMatch(/nothing was lost/i);
    expect(error.message).toMatch(/open the pair again/i);
  });

  it("reports any other refusal plainly", async () => {
    const { auth } = fakeAuth(() => fail(500, { message: "worker exploded" }));
    const error = await rejection(resolveConflict(auth, "c1", {}, 7));
    expect(error.stale).toBe(false);
    expect(error.message).toBe("worker exploded");
  });

  it("does not treat a plain 404 as staleness", async () => {
    // Telling an author their merge went stale when the copy simply no longer exists
    // sends them looking for a pair that is not there.
    const { auth } = fakeAuth(() => fail(404, {}));
    const error = await rejection(resolveConflict(auth, "c1", {}, 7));
    expect(error.stale).toBe(false);
  });
});

describe("the double itself", () => {
  it("records what was sent", async () => {
    // Guards the assertions above: a double that recorded nothing would make several
    // of them pass without a request ever being made.
    const { auth, calls } = fakeAuth(() => ok({}));
    expect(calls).toEqual([]);
    await resolveConflict(auth, "c1", {}, 1);
    expect(calls).toHaveLength(1);
  });
});
