import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseProvider } from "@/app/db/DatabaseProvider";
import { SettingsProvider } from "@/app/settings/SettingsProvider";
import { DEFAULT_SETTINGS } from "@/app/settings/settings";
import { AuthProvider } from "@/features/auth/AuthProvider";
import type { Session } from "@/features/auth/session";
import { DatabaseClient } from "@/db/client";
import { fakeWorker } from "@/test/worker";
import { useSync } from "../useSync";

/**
 * When the first sync happens, which is a decision this hook makes and the scheduler
 * only carries out.
 *
 * The engine is doubled deliberately. What is under test is *whether* a sync starts and
 * *when*, not what one does — simulating the whole push/pull protocol here would bury the
 * one assertion that matters under a mock server.
 */
vi.mock("../engine", () => ({
  syncProject: vi.fn(() => Promise.resolve({ conflicts: [], dropped: 0, pushed: 0, pulled: 0 })),
}));
const { syncProject } = await import("../engine");

const SESSION: Session = {
  serverUrl: "https://write.example.com",
  userId: "u1",
  deviceId: "d1",
  refreshToken: "r",
  email: "author@example.com",
};

const WINDOW_MS = 15 * 60 * 1000;

/**
 * Advances fake timers and lets whatever they released finish.
 *
 * Not `waitFor`: it polls on real timers, which fake timers have replaced, so it waits
 * out its own timeout no matter what the code does.
 */
const settle = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(syncProject).mockClear();
});
afterEach(() => vi.useRealTimers());

/**
 * @param lastSyncedAt null stands for a replica that has never synced this project.
 */
function harness(lastSyncedAt: string | null) {
  const fake = fakeWorker();
  const client = new DatabaseClient(fake.worker);

  const wrapper = ({ children }: { children: ReactNode }) => (
    <SettingsProvider initial={DEFAULT_SETTINGS}>
      <DatabaseProvider create={() => client}>
        <AuthProvider initialSession={SESSION} fetcher={vi.fn<typeof fetch>()}>
          {children}
        </AuthProvider>
      </DatabaseProvider>
    </SettingsProvider>
  );

  const view = renderHook(() => useSync("project-1"), { wrapper });
  // The client holds requests until the worker says it is open.
  act(() => {
    fake.reply({ kind: "ready", storage: "memory", appliedVersions: [], schemaVersion: 11 });
  });

  /** Answers the syncState read the hook makes on mount. */
  const answerStateRead = async () => {
    await act(async () => {
      fake.answerAll({
        lastChangeId: lastSyncedAt === null ? 0 : 42,
        syncEpoch: 0,
        lastSyncedAt,
        lastError: null,
        pending: 0,
      });
      await Promise.resolve();
    });
  };

  return { ...view, fake, answerStateRead };
}

describe("a replica that has never synced this project", () => {
  it("syncs at once rather than sitting empty for fifteen minutes", async () => {
    const { answerStateRead } = harness(null);

    await answerStateRead();
    await settle(0);

    // The moment somebody signs in on a new device is the moment they are watching for
    // their book to appear. Waiting out the window here is the app doing nothing, visibly.
    expect(syncProject).toHaveBeenCalledTimes(1);
  });
});

describe("a replica that has synced before", () => {
  it("waits out the window, which is what the window is for", async () => {
    const { answerStateRead } = harness("2026-08-27T10:00:00.000Z");

    await answerStateRead();
    await settle(WINDOW_MS - 1);

    expect(syncProject).not.toHaveBeenCalled();

    await settle(1);
    expect(syncProject).toHaveBeenCalledTimes(1);
  });

  it("does not sync while its state is still being read", async () => {
    // The scheduler is built before that read finishes. If "unknown" were treated as
    // "never synced", every app open would sync every replica immediately and the
    // window would protect nothing.
    harness("2026-08-27T10:00:00.000Z");

    await settle(0);

    expect(syncProject).not.toHaveBeenCalled();
  });
});

describe("the conflicts notice", () => {
  const conflict = (entityId: string) => ({
    entityId,
    entityType: "document",
    reason: "stale_base",
    conflictCopyId: `copy-${entityId}`,
    serverVersion: 5,
    detail: null,
  });
  const run = (ms = 0) => settle(ms);

  it("outlives the next run, which is what lets an author who looked away still read it", async () => {
    const { answerStateRead, result } = harness(null);
    vi.mocked(syncProject).mockResolvedValueOnce({ conflicts: [conflict("a")], dropped: 0, pushed: 1, pulled: 0 } as never);
    await answerStateRead();
    await run();
    expect(result.current.conflicts).toHaveLength(1);

    // Nothing to report this time.
    // The first run's closing read of sync state, which has to be answered for it to end.
    await answerStateRead();
    act(() => result.current.syncNow());
    await settle(10);
    expect(syncProject).toHaveBeenCalledTimes(2);

    expect(result.current.conflicts).toHaveLength(1);
  });

  it("adds a different conflict, lists a repeated one once, and clears when dismissed", async () => {
    const { answerStateRead, result } = harness(null);
    vi.mocked(syncProject)
      .mockResolvedValueOnce({ conflicts: [conflict("a")], dropped: 0, pushed: 1, pulled: 0 } as never)
      .mockResolvedValueOnce({ conflicts: [conflict("a"), conflict("b")], dropped: 0, pushed: 1, pulled: 0 } as never);
    await answerStateRead();
    await run();
    // The first run's closing read of sync state, which has to be answered for it to end.
    await answerStateRead();
    act(() => result.current.syncNow());
    await settle(10);
    expect(syncProject).toHaveBeenCalledTimes(2);

    expect(result.current.conflicts.map((c) => c.entityId)).toEqual(["a", "b"]);

    act(() => result.current.dismissConflicts());
    expect(result.current.conflicts).toEqual([]);
  });
});
