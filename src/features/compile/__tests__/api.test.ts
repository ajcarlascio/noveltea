import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Authenticator } from "@/features/auth/authenticate";
import { CompileFailed, download, isTerminal, jobStatus, listFormats, submit } from "../api";

/** Awaits a rejection and hands it back typed; tsc cannot narrow a catch. */
async function rejection(promise: Promise<unknown>): Promise<CompileFailed> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CompileFailed) return error;
    throw error;
  }
  throw new Error("expected the call to fail, and it did not");
}

/** The JSON body a recorded call carried. */
function bodyOf(init: RequestInit | undefined): unknown {
  const body = init?.body;
  return typeof body === "string" ? JSON.parse(body) : null;
}

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

const ok = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
const fail = (status: number, body: unknown = {}) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

describe("formats", () => {
  it("reports what is unavailable rather than hiding it", async () => {
    // Open core: a format missing from this build is an upgrade, not a thing that
    // does not exist. Hiding it would make the interface lie about the software.
    const { auth } = fakeAuth(() => ok({ supported: ["txt", "md", "html"], unavailable: ["docx", "pdf"] }));
    await expect(listFormats(auth, "p1")).resolves.toEqual({
      supported: ["txt", "md", "html"],
      unavailable: ["docx", "pdf"],
    });
  });

  it("survives a response missing either list", async () => {
    const { auth } = fakeAuth(() => ok({}));
    await expect(listFormats(auth, "p1")).resolves.toEqual({ supported: [], unavailable: [] });
  });

  it("ignores entries that are not format names", async () => {
    const { auth } = fakeAuth(() => ok({ supported: ["txt", 3, null, { a: 1 }] }));
    await expect(listFormats(auth, "p1")).resolves.toMatchObject({ supported: ["txt"] });
  });
});

describe("submitting", () => {
  it("posts the format and destination and returns the job id", async () => {
    const { auth, calls } = fakeAuth(() => ok({ id: "job-1" }));
    await expect(submit(auth, "p1", "md", "download")).resolves.toBe("job-1");

    expect(calls[0]!.path).toBe("/api/v1/projects/p1/compile");
    expect(bodyOf(calls[0]!.init)).toEqual({ format: "md", destination: "download" });
  });

  it("explains a commercial format as an upgrade, not a fault", async () => {
    // The author's writing is fine; it is the export that needs a different edition.
    const { auth } = fakeAuth(() => fail(501, { code: "unavailable_in_this_edition" }));
    await expect(submit(auth, "p1", "docx", "download")).rejects.toThrow(/edition of NovelTea/i);
    await expect(submit(auth, "p1", "docx", "download")).rejects.toThrow(/writing is unaffected/i);
  });

  it("explains a queue limit as something to wait out", async () => {
    const { auth } = fakeAuth(() => fail(429, { code: "too_many_pending_compiles" }));
    await expect(submit(auth, "p1", "md", "download")).rejects.toThrow(/let one finish/i);
  });

  it("refuses a response that names no job", async () => {
    const { auth } = fakeAuth(() => ok({ started: true }));
    await expect(submit(auth, "p1", "md", "download")).rejects.toThrow(/did not say which job/i);
  });

  it("passes a message the server did author", async () => {
    const { auth } = fakeAuth(() => fail(400, { code: "no_documents", message: "nothing to compile" }));
    const error = await rejection(submit(auth, "p1", "md", "download"));
    expect(error.message).toBe("nothing to compile");
    expect(error.code).toBe("no_documents");
  });
});

describe("polling", () => {
  it("reads a finished job", async () => {
    const { auth } = fakeAuth(() =>
      ok({ id: "job-1", format: "md", destination: "download", status: "done",
           outputFilename: "book.md", outputBytes: 4096, wordCount: 812 }),
    );
    await expect(jobStatus(auth, "job-1")).resolves.toMatchObject({
      status: "done", outputFilename: "book.md", wordCount: 812,
    });
  });

  it("treats an unrecognised status as still running", async () => {
    // Reporting "done" for something that is not would offer a download of nothing.
    const { auth } = fakeAuth(() => ok({ id: "job-1", status: "reticulating" }));
    await expect(jobStatus(auth, "job-1")).resolves.toMatchObject({ status: "running" });
  });

  it("knows which statuses end the wait", () => {
    expect(isTerminal("done")).toBe(true);
    expect(isTerminal("failed")).toBe(true);
    expect(isTerminal("queued")).toBe(false);
    expect(isTerminal("running")).toBe(false);
  });

  it("carries the reason a job failed", async () => {
    const { auth } = fakeAuth(() => ok({ id: "job-1", status: "failed", errorMessage: "worker died" }));
    await expect(jobStatus(auth, "job-1")).resolves.toMatchObject({
      status: "failed", errorMessage: "worker died",
    });
  });
});

describe("downloading", () => {
  // jsdom implements neither, so they are stubbed rather than the code avoiding them:
  // a blob URL is the only way to hand an authenticated download to the browser.
  let created: string[] = [];
  let revoked: string[] = [];

  beforeEach(() => {
    created = [];
    revoked = [];
    URL.createObjectURL = vi.fn((): string => {
      const url = `blob:test/${String(created.length)}`;
      created.push(url);
      return url;
    });
    URL.revokeObjectURL = vi.fn((url: string) => void revoked.push(url));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const job = {
    id: "job-1", format: "md", destination: "download", status: "done" as const,
    outputFilename: "book.md", outputBytes: 10, wordCount: 5, warnings: null, errorMessage: null,
  };

  it("fetches with the bearer token rather than linking to the URL", async () => {
    // An <a href> sends no headers, so a plain link to an authenticated route
    // downloads a 401 page named like a manuscript.
    const { auth, calls } = fakeAuth(() => Promise.resolve(new Response("# Book", { status: 200 })));
    const click = vi.fn();
    const link = { href: "", download: "", click };

    await download(auth, job, () => link);

    expect(calls[0]!.path).toBe("/api/v1/compile-jobs/job-1/download");
    expect(click).toHaveBeenCalledTimes(1);
    expect(link.download).toBe("book.md");
  });

  it("releases the blob rather than pinning the manuscript in memory", async () => {
    const { auth } = fakeAuth(() => Promise.resolve(new Response("# Book", { status: 200 })));
    const link = { href: "", download: "", click: vi.fn() };

    await download(auth, job, () => link);

    // A novel held open for the life of the tab, once per export, otherwise.
    expect(revoked).toEqual(created);
  });

  it("names the file after the format when the server did not name it", async () => {
    const { auth } = fakeAuth(() => Promise.resolve(new Response("x", { status: 200 })));
    const link = { href: "", download: "", click: vi.fn() };

    await download(auth, { ...job, outputFilename: null }, () => link);
    expect(link.download).toBe("manuscript.md");
  });

  it("says exports expire when the file has gone", async () => {
    const { auth } = fakeAuth(() => Promise.resolve(new Response("", { status: 404 })));
    const link = { href: "", download: "", click: vi.fn() };

    await expect(
      download(auth, job, () => link),
    ).rejects.toThrow(/expire/i);
  });
});
