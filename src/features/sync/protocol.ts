/**
 * The sync wire shapes, mirroring the server's OpenAPI document.
 *
 * Everything arriving here is validated before it reaches the database: a sync
 * response is the largest untrusted payload this client accepts, and one malformed
 * row must not stall the feed or corrupt a replica.
 */

export interface ChangeRecord {
  id: number;
  entityType: string;
  entityId: string;
  op: string;
  data: Record<string, unknown> | null;
}

export interface PullResponse {
  changes: ChangeRecord[];
  /** Highest id *actually served*, never the feed's maximum. */
  latestId: number;
  hasMore: boolean;
  resyncRequired: boolean;
  syncEpoch: number;
  /** Rows the server sent that this client could not parse and had to skip. */
  dropped: number;
}

export interface ChangeRequest {
  entityType: string;
  entityId: string;
  op: string;
  baseVersion: number | null;
  data: unknown;
}

export const CONFLICT_REASONS = [
  "version_mismatch",
  "duplicate_create",
  "entity_missing",
  "invalid_request",
  "not_implemented",
] as const;

export type ConflictReason = (typeof CONFLICT_REASONS)[number];

/** A reason this client recognises. Anything else is treated as undecided-and-final. */
export function isKnownReason(value: string): value is ConflictReason {
  return (CONFLICT_REASONS as readonly string[]).includes(value);
}

export interface ConflictRecord {
  entityId: string;
  entityType: string;
  /** One of CONFLICT_REASONS, or something a newer server invented. */
  reason: string;
  /** The binder item holding the client's rejected text, when one was made. */
  conflictCopyId: string | null;
  serverVersion: number | null;
  detail: string | null;
}

export interface PushResponse {
  applied: { entityId: string; entityType: string; version: number }[];
  conflicts: ConflictRecord[];
  latestId: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Validates a pull response, dropping rows that are not changes.
 *
 * A row without an id or an entity id cannot be applied and cannot advance a cursor;
 * refusing the whole page over one would stall sync permanently on a single bad row,
 * which is worse than skipping it.
 */
export function parsePullResponse(raw: unknown): PullResponse {
  if (!isRecord(raw)) throw new Error("The server's sync response was not an object.");

  if (
    typeof raw.latestId !== "number" ||
    !Number.isInteger(raw.latestId) ||
    raw.latestId < 0
  ) {
    throw new Error("The server's sync response had no valid latestId.");
  }

  const changes: ChangeRecord[] = [];
  let dropped = 0;
  const rows = Array.isArray(raw.changes) ? raw.changes : [];
  for (const row of rows) {
    if (!isRecord(row)) {
      dropped += 1;
      continue;
    }
    if (typeof row.id !== "number" || typeof row.entityId !== "string") {
      dropped += 1;
      continue;
    }
    if (typeof row.entityType !== "string" || typeof row.op !== "string") {
      dropped += 1;
      continue;
    }
    changes.push({
      id: row.id,
      entityType: row.entityType,
      entityId: row.entityId,
      op: row.op,
      data: isRecord(row.data) ? row.data : null,
    });
  }

  const latestId = raw.latestId;
  return {
    changes,
    latestId,
    hasMore: raw.hasMore === true,
    resyncRequired: raw.resyncRequired === true,
    syncEpoch: typeof raw.syncEpoch === "number" ? raw.syncEpoch : 1,
    dropped,
  };
}

export function parsePushResponse(raw: unknown): PushResponse {
  if (!isRecord(raw)) throw new Error("The server's push response was not an object.");

  const applied = (Array.isArray(raw.applied) ? raw.applied : [])
    .filter(isRecord)
    .filter((row) => typeof row.entityId === "string" && typeof row.entityType === "string")
    .map((row) => ({
      entityId: row.entityId as string,
      entityType: row.entityType as string,
      version: typeof row.version === "number" ? row.version : 0,
    }));

  const conflicts = (Array.isArray(raw.conflicts) ? raw.conflicts : [])
    .filter(isRecord)
    .filter((row) => typeof row.entityId === "string")
    .map((row) => ({
      entityId: row.entityId as string,
      entityType: typeof row.entityType === "string" ? row.entityType : "unknown",
      reason: typeof row.reason === "string" ? row.reason : "invalid_request",
      conflictCopyId: typeof row.conflictCopyId === "string" ? row.conflictCopyId : null,
      serverVersion: typeof row.serverVersion === "number" ? row.serverVersion : null,
      detail: typeof row.detail === "string" ? row.detail : null,
    }));

  return {
    applied,
    conflicts,
    latestId: typeof raw.latestId === "number" ? raw.latestId : 0,
  };
}

/**
 * Whether a refused change should stay queued.
 *
 * Only `not_implemented` is worth keeping: the server may learn to accept that entity
 * type in a later version, and the change is still valid. Everything else has already
 * had its outcome decided —
 *
 * - `version_mismatch` on a document means the server kept its version and preserved
 *   the author's text as a conflict copy. **Retrying would create another copy on
 *   every push**, and copies would breed without bound.
 * - `duplicate_create` means the server already has it.
 * - `entity_missing` and `invalid_request` will not become true by being sent again.
 */
export function shouldStayQueued(reason: string): boolean {
  return reason === "not_implemented";
}
