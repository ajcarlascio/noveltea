import { describe, expect, it } from "vitest";
import { parsePullResponse, parsePushResponse, shouldStayQueued } from "../protocol";

/**
 * A sync response is the largest untrusted payload this client accepts. One malformed
 * row must not stall the feed, and nothing malformed may reach the database.
 */
describe("parsePullResponse", () => {
  it("reads a well-formed page", () => {
    const parsed = parsePullResponse({
      changes: [{ id: 4, entityType: "binder_item", entityId: "b1", op: "update", data: { title: "x" } }],
      latestId: 4,
      hasMore: true,
      resyncRequired: false,
      syncEpoch: 2,
    });
    expect(parsed.changes).toHaveLength(1);
    expect(parsed).toMatchObject({ latestId: 4, hasMore: true, syncEpoch: 2 });
  });

  it("drops rows that cannot be applied, keeping the rest", () => {
    // Refusing the whole page over one bad row would stall sync permanently.
    const parsed = parsePullResponse({
      changes: [
        null,
        "nonsense",
        { id: "not a number", entityType: "binder_item", entityId: "b1", op: "update" },
        { id: 2, entityId: "b2", op: "update" },
        { id: 3, entityType: "binder_item", entityId: "b3", op: "update", data: null },
      ],
      latestId: 3,
    });
    expect(parsed.changes.map((c) => c.entityId)).toEqual(["b3"]);
    // The cursor moves past dropped rows, so the skip must be visible, not silent.
    expect(parsed.dropped).toBe(4);
  });

  it("treats a non-object data field as absent rather than passing it through", () => {
    const parsed = parsePullResponse({
      changes: [{ id: 1, entityType: "binder_item", entityId: "b1", op: "update", data: "oops" }],
      latestId: 1,
    });
    expect(parsed.changes[0]!.data).toBeNull();
  });

  it("defaults the flags conservatively when they are missing", () => {
    const parsed = parsePullResponse({});
    // hasMore false stops a loop; resyncRequired false avoids a destructive rebuild
    // on a malformed answer.
    expect(parsed).toMatchObject({ latestId: 0, hasMore: false, resyncRequired: false, syncEpoch: 1 });
    expect(parsed.changes).toEqual([]);
  });

  it("only treats an explicit true as a resync instruction", () => {
    expect(parsePullResponse({ resyncRequired: "yes" }).resyncRequired).toBe(false);
    expect(parsePullResponse({ resyncRequired: 1 }).resyncRequired).toBe(false);
    expect(parsePullResponse({ resyncRequired: true }).resyncRequired).toBe(true);
  });

  it("refuses a response that is not an object at all", () => {
    for (const raw of [null, "x", 3, []]) {
      expect(() => parsePullResponse(raw)).toThrow(/not an object/i);
    }
  });
});

describe("parsePushResponse", () => {
  it("reads applied entries and conflicts", () => {
    const parsed = parsePushResponse({
      applied: [{ entityId: "b1", entityType: "binder_item", version: 3 }],
      conflicts: [
        {
          entityId: "d1",
          entityType: "document",
          reason: "version_mismatch",
          conflictCopyId: "copy-1",
          serverVersion: 7,
          detail: "stale",
        },
      ],
      latestId: 12,
    });
    expect(parsed.applied[0]).toMatchObject({ entityId: "b1", version: 3 });
    expect(parsed.conflicts[0]).toMatchObject({ conflictCopyId: "copy-1", serverVersion: 7 });
  });

  it("drops entries with no entity id, which cannot be settled against the queue", () => {
    const parsed = parsePushResponse({
      applied: [{ entityType: "binder_item" }, { entityId: "b1", entityType: "binder_item", version: 1 }],
      conflicts: [{ reason: "invalid_request" }],
    });
    expect(parsed.applied).toHaveLength(1);
    expect(parsed.conflicts).toHaveLength(0);
  });

  it("defaults a missing conflict reason to something that will not be retried", () => {
    // Retrying an unknown refusal forever is worse than dropping it once.
    const parsed = parsePushResponse({ conflicts: [{ entityId: "d1" }] });
    expect(parsed.conflicts[0]!.reason).toBe("invalid_request");
    expect(shouldStayQueued(parsed.conflicts[0]!.reason)).toBe(false);
  });

  it("survives arrays that are not arrays", () => {
    const parsed = parsePushResponse({ applied: "no", conflicts: 3 });
    expect(parsed).toMatchObject({ applied: [], conflicts: [], latestId: 0 });
  });
});

describe("shouldStayQueued", () => {
  it("keeps only what a later server version might accept", () => {
    expect(shouldStayQueued("not_implemented")).toBe(true);
  });

  it("clears everything whose outcome is already decided", () => {
    // version_mismatch above all: the server kept its version and preserved the
    // author's text as a conflict copy. Retrying would make another copy every push.
    for (const reason of ["version_mismatch", "duplicate_create", "entity_missing", "invalid_request", "who_knows"]) {
      expect(shouldStayQueued(reason), reason).toBe(false);
    }
  });
});
