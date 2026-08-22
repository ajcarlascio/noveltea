// @vitest-environment node
import { describe, expect, it } from "vitest";
import { isOrphaned, listComments, parseAnchor, type CommentAnchor } from "@/data/comments";

/**
 * The orphan rule and the threading rule, which are the parts worth pinning. Neither
 * needs SQL — `listComments` is driven here through a reader that answers with rows.
 */

const anchor = (quotedText: string): CommentAnchor => ({ from: 3, to: 12, quotedText });

describe("isOrphaned", () => {
  it("holds while the quoted words are still there", () => {
    expect(isOrphaned(anchor("lighthouse keeper"), "the lighthouse keeper waited")).toBe(false);
  });

  it("survives the passage moving, because it matches words and not offsets", () => {
    // Offsets drift with every character typed above them. The words usually survive.
    expect(
      isOrphaned(anchor("lighthouse keeper"), "a long new opening, then the lighthouse keeper"),
    ).toBe(false);
  });

  it("reports a quotation that is gone", () => {
    expect(isOrphaned(anchor("lighthouse keeper"), "an entirely rewritten scene")).toBe(true);
  });

  it("ignores how whitespace fell between the two", () => {
    // The quotation comes from an editor selection, which puts a blank line between
    // blocks; the haystack is the same prose flattened one block per line. Compared
    // literally, every comment quoting across a paragraph break orphans itself the
    // instant it is made, with the passage still sitting there.
    expect(isOrphaned(anchor("waited\n\nmorning came"), "the keeper waited\nmorning came slowly")).toBe(
      false,
    );
  });

  it("never orphans a note that was not pointing anywhere", () => {
    expect(isOrphaned(null, "anything at all")).toBe(false);
  });

  it("never orphans an anchor quoting nothing", () => {
    // An empty quotation matches everywhere, and calling it orphaned would be a
    // permanent warning about a note that never lost anything.
    expect(isOrphaned(anchor("   "), "unrelated prose")).toBe(false);
  });

  it("orphans against a document with no text at all", () => {
    expect(isOrphaned(anchor("lighthouse"), null)).toBe(true);
  });
});

describe("parseAnchor", () => {
  it("reads a well-formed anchor", () => {
    expect(parseAnchor('{"from":3,"to":12,"quotedText":"the stair"}')).toEqual({
      from: 3,
      to: 12,
      quotedText: "the stair",
    });
  });

  it("treats a malformed anchor as no anchor rather than failing", () => {
    // The note is still somebody's words. Losing it because a position was written
    // oddly by another device is the worse outcome.
    expect(parseAnchor("not json at all")).toBeNull();
    expect(parseAnchor('{"from":3}')).toBeNull();
    expect(parseAnchor(null)).toBeNull();
  });

  it("keeps the quotation when the offsets are missing", () => {
    // The offsets are a hint; the quotation is what decides orphaning.
    expect(parseAnchor('{"quotedText":"the stair"}')).toEqual({
      from: 0,
      to: 0,
      quotedText: "the stair",
    });
  });
});

interface Row {
  id: string;
  document_id: string;
  parent_comment_id: string | null;
  body: string;
  anchor: string | null;
  resolved_at: string | null;
  created_at: string;
  version: number;
}

const comment = (over: Partial<Row> & Pick<Row, "id">): Row => ({
  document_id: "d1",
  parent_comment_id: null,
  body: "a note",
  anchor: null,
  resolved_at: null,
  created_at: "2026-08-01T00:00:00Z",
  version: 1,
  ...over,
});

/** Answers the document query first and the comment query second, as listComments asks. */
const reader = (rows: Row[], searchText: string | null) => ({
  query: <T>(sql: string): Promise<T[]> =>
    Promise.resolve(
      (sql.includes("FROM document") ? [{ search_text: searchText }] : rows) as T[],
    ),
});

describe("listComments", () => {
  it("nests replies under their thread", async () => {
    const threads = await listComments(
      reader(
        [
          comment({ id: "c1" }),
          comment({ id: "r1", parent_comment_id: "c1", body: "I think so" }),
          comment({ id: "c2", body: "another" }),
        ],
        "prose",
      ),
      "p1",
      "d1",
    );

    expect(threads).toHaveLength(2);
    expect(threads[0]?.comment.id).toBe("c1");
    expect(threads[0]?.replies.map((reply) => reply.id)).toEqual(["r1"]);
    expect(threads[1]?.replies).toEqual([]);
  });

  it("keeps a reply whose thread is gone rather than dropping it", async () => {
    // The parent can be deleted on another device. The reply is still somebody's
    // words, and losing them silently is worse than showing them out of place.
    const threads = await listComments(
      reader([comment({ id: "r1", parent_comment_id: "missing", body: "orphaned reply" })], "prose"),
      "p1",
      "d1",
    );

    expect(threads).toHaveLength(1);
    expect(threads[0]?.comment.body).toBe("orphaned reply");
  });

  it("marks a thread orphaned against the document it was read with", async () => {
    const threads = await listComments(
      reader(
        [
          comment({ id: "c1", anchor: '{"from":1,"to":5,"quotedText":"lighthouse"}' }),
          comment({ id: "c2", anchor: '{"from":1,"to":5,"quotedText":"gone entirely"}' }),
        ],
        "the lighthouse waited",
      ),
      "p1",
      "d1",
    );

    expect(threads[0]?.comment.orphaned).toBe(false);
    expect(threads[1]?.comment.orphaned).toBe(true);
  });

  it("reports resolution as a flag rather than a timestamp", async () => {
    const threads = await listComments(
      reader([comment({ id: "c1", resolved_at: "2026-08-02T00:00:00Z" })], "prose"),
      "p1",
      "d1",
    );
    expect(threads[0]?.comment.resolved).toBe(true);
  });
});
