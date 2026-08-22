import type { Authenticator } from "@/features/auth/authenticate";
import type { ProseMirrorNode } from "@/features/editor/text";

/**
 * Conflict copies, and reconciling them.
 *
 * The server never merges prose — deliberately, permanently. When two devices edit one
 * document and the second is behind, the server keeps its own version and preserves
 * the author's text as a sibling binder item. Nothing is overwritten and nothing is
 * dropped; what is left is a decision only a person can make.
 *
 * No diff is computed server-side either, because only the editor understands
 * ProseMirror JSON. The server returns both documents and their provenance; the
 * reconciling happens here.
 */

export interface ConflictSummary {
  copyId: string;
  originalId: string;
  originalTitle: string;
  copyTitle: string;
  /** The version the losing device had when it forked. */
  forkedFromVersion: number;
  /** The original document's version now — what a resolve is validated against. */
  originalVersion: number;
  forkedAt: string | null;
}

export interface ConflictDetail extends Omit<ConflictSummary, "copyTitle"> {
  originalContent: ProseMirrorNode | null;
  copyContent: ProseMirrorNode | null;
}

export class ResolveRejected extends Error {
  constructor(message: string, readonly stale: boolean) {
    super(message);
    this.name = "ResolveRejected";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

const text = (value: unknown, fallback = "") => (typeof value === "string" ? value : fallback);
const num = (value: unknown) => (typeof value === "number" ? value : 0);

function toSummary(raw: unknown): ConflictSummary | null {
  if (!isRecord(raw) || typeof raw.copyId !== "string" || typeof raw.originalId !== "string") {
    return null;
  }
  return {
    copyId: raw.copyId,
    originalId: raw.originalId,
    originalTitle: text(raw.originalTitle, "Untitled"),
    copyTitle: text(raw.copyTitle, "Conflicted copy"),
    forkedFromVersion: num(raw.forkedFromVersion),
    originalVersion: num(raw.originalVersion),
    forkedAt: typeof raw.forkedAt === "string" ? raw.forkedAt : null,
  };
}

async function read(response: Response, what: string): Promise<unknown> {
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { code?: unknown; message?: unknown };
    const code = typeof body.code === "string" ? body.code : "";

    // The server refuses a stale baseVersion rather than forking again — forking on
    // merge would let copies breed without bound. It is not an error to report as a
    // failure: the pair simply moved on, and the author needs to see it again.
    if (response.status === 409 || code === "stale_original") {
      throw new ResolveRejected(
        "This document changed on another device while you were merging. Nothing was lost — open the pair again to see both versions as they are now.",
        true,
      );
    }
    const message = typeof body.message === "string" ? body.message : "";
    throw new ResolveRejected(
      message.length > 0 ? message : `The server could not ${what} (${String(response.status)}).`,
      false,
    );
  }
  return response.json();
}

export async function listConflicts(
  auth: Authenticator,
  projectId: string,
): Promise<ConflictSummary[]> {
  const raw = await read(
    await auth.fetch(`/api/v1/projects/${projectId}/conflicts`),
    "list conflicts",
  );
  return (Array.isArray(raw) ? raw : []).map(toSummary).filter((row): row is ConflictSummary => row !== null);
}

export async function loadConflict(auth: Authenticator, copyId: string): Promise<ConflictDetail> {
  const raw = await read(await auth.fetch(`/api/v1/conflicts/${copyId}`), "read the conflict");
  const summary = toSummary(raw);
  if (summary === null || !isRecord(raw)) {
    throw new ResolveRejected("The server described the conflict in a shape this version does not understand.", false);
  }
  return {
    ...summary,
    originalContent: isRecord(raw.originalContent) ? raw.originalContent : null,
    copyContent: isRecord(raw.copyContent) ? raw.copyContent : null,
  };
}

/**
 * Writes the reconciled text back and trashes the copy.
 *
 * `baseVersion` is the *original document's* version, which is what the server
 * validates. The binder item carries its own version for structural edits, and
 * sending that one produces a baseVersion that can never match.
 */
export async function resolveConflict(
  auth: Authenticator,
  copyId: string,
  content: unknown,
  originalVersion: number,
): Promise<void> {
  await read(
    await auth.fetch(`/api/v1/conflicts/${copyId}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content, baseVersion: originalVersion }),
    }),
    "resolve the conflict",
  );
}
