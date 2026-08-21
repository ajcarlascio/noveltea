import type { DatabaseClient } from "@/db/client";
import type { Authenticator } from "@/features/auth/authenticate";
import {
  parsePullResponse,
  parsePushResponse,
  shouldStayQueued,
  type ConflictRecord,
} from "./protocol";

/**
 * One sync pass for one project: pull everything waiting, then push everything local.
 *
 * Pull first, deliberately. Pushing into a stale picture is how a client resurrects
 * something another device deleted; arriving up to date means the push is judged
 * against the same state the author was last shown.
 */

export interface SyncOutcome {
  pulled: number;
  pushed: number;
  conflicts: ConflictRecord[];
  /** Entity types the server sent that this client's schema has no table for. */
  skipped: string[];
  resynced: boolean;
}

export interface SyncDeps {
  db: DatabaseClient;
  auth: Authenticator;
  /** Guards against a pathological server pinning the client in a pull loop. */
  maxPages?: number;
  pageSize?: number;
}

export class SyncFailed extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SyncFailed";
  }
}

async function json(response: Response, what: string): Promise<unknown> {
  if (!response.ok) {
    throw new SyncFailed(`The server refused to ${what} (${String(response.status)}).`);
  }
  try {
    return await response.json();
  } catch (cause) {
    throw new SyncFailed(`The server's ${what} response was not readable.`, { cause });
  }
}

export async function syncProject(
  { db, auth, maxPages = 100, pageSize = 200 }: SyncDeps,
  projectId: string,
): Promise<SyncOutcome> {
  const outcome: SyncOutcome = { pulled: 0, pushed: 0, conflicts: [], skipped: [], resynced: false };

  try {
    const state = await db.command("syncState", { projectId });
    let cursor = state.lastChangeId;
    let epoch = state.syncEpoch;

    for (let page = 0; page < maxPages; page += 1) {
      const response = await auth.fetch(
        `/api/v1/projects/${projectId}/sync?since=${String(cursor)}&limit=${String(pageSize)}&epoch=${String(epoch)}`,
      );
      const pull = parsePullResponse(await json(response, "pull changes"));

      if (pull.resyncRequired) {
        // The cursor points into history the server can no longer explain: retention
        // purged it, or the project was restored from an older backup.
        //
        // The local replica is deliberately NOT wiped. The server has no endpoint that
        // returns a document's current body — the feed carries content, but only for
        // rows since the cursor — so discarding local prose would destroy writing that
        // cannot be fetched back. Structure is reconciled from the binder; bodies are
        // kept as the last known good text and corrected by later changes.
        await reconcileTree(db, auth, projectId);
        cursor = pull.latestId;
        epoch = pull.syncEpoch;
        outcome.resynced = true;
        // Resuming *at* latestId, not at 0: pulling from 0 would land below the purge
        // point again and ask for a resync forever.
        await db.command("applyPull", {
          projectId,
          changes: [],
          latestId: cursor,
          syncEpoch: epoch,
        });
        continue;
      }

      // Always applied, even for an empty page. A page with no rows still moves the
      // feed position, and leaving that unwritten means re-asking for the same empty
      // range on every sync, forever.
      const applied = await db.command("applyPull", {
        projectId,
        changes: pull.changes,
        latestId: pull.latestId,
        syncEpoch: pull.syncEpoch,
      });
      outcome.pulled += applied.applied;
      for (const type of applied.skipped) {
        if (!outcome.skipped.includes(type)) outcome.skipped.push(type);
      }

      cursor = pull.latestId;
      epoch = pull.syncEpoch;
      if (!pull.hasMore) break;
    }

    // -- push ---------------------------------------------------------------------
    const pending = await db.command("takePending", { projectId, limit: pageSize });
    if (pending.length > 0) {
      const response = await auth.fetch(`/api/v1/projects/${projectId}/sync`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          since: cursor,
          changes: pending.map((row) => ({
            entityType: row.entityType,
            entityId: row.entityId,
            op: row.op,
            baseVersion: row.baseVersion,
            data: row.data,
          })),
        }),
      });
      const push = parsePushResponse(await json(response, "accept changes"));

      const settled = new Set<string>();
      for (const row of push.applied) settled.add(`${row.entityType}:${row.entityId}`);
      for (const conflict of push.conflicts) {
        if (!shouldStayQueued(conflict.reason)) settled.add(`${conflict.entityType}:${conflict.entityId}`);
      }

      const ids = pending
        .filter((row) => settled.has(`${row.entityType}:${row.entityId}`))
        .map((row) => row.id);

      await db.command("settlePush", { ids });
      outcome.pushed = push.applied.length;
      outcome.conflicts = push.conflicts;
    }

    return outcome;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    // Recorded without touching the cursor: a failed attempt must not look like
    // progress, and must not lose the position the client had reached.
    await db.command("recordSyncFailure", { projectId, error: message });
    throw cause;
  }
}

/**
 * Brings the binder tree back in line with the server after a resync.
 *
 * Items the server no longer lists are tombstoned locally — they are genuinely gone.
 * Items it does list are upserted. Document bodies are untouched for the reason given
 * at the call site.
 */
async function reconcileTree(
  db: DatabaseClient,
  auth: Authenticator,
  projectId: string,
): Promise<void> {
  const response = await auth.fetch(`/api/v1/projects/${projectId}/binder`);
  const tree = await json(response, "read the binder");
  const flat = flattenBinder(tree);

  await db.command("applyPull", {
    projectId,
    changes: flat.map((node, index) => ({
      id: index,
      entityType: "binder_item",
      entityId: node.id,
      op: "update",
      data: { ...node, project_id: projectId },
    })),
    // The cursor is set by the caller; this page must not move it.
    latestId: 0,
    syncEpoch: 0,
  });
}

interface FlatNode extends Record<string, unknown> {
  id: string;
}

/** The server returns a tree; the replica stores a flat list with parent ids. */
function flattenBinder(raw: unknown, parentId: string | null = null): FlatNode[] {
  if (Array.isArray(raw)) return raw.flatMap((node) => flattenBinder(node, parentId));
  if (raw === null || typeof raw !== "object") return [];

  const node = raw as Record<string, unknown>;
  if (Array.isArray(node.roots)) return flattenBinder(node.roots, null);
  if (typeof node.id !== "string") return [];

  // The binder response carries no created_at, and the column is NOT NULL. On a
  // resync some of these rows are new to this client, so a value has to come from
  // somewhere: updatedAt is the closest true thing available.
  const updatedAt = typeof node.updatedAt === "string" ? node.updatedAt : new Date().toISOString();

  const flat: FlatNode = {
    id: node.id,
    parent_id: typeof node.parentId === "string" ? node.parentId : parentId,
    type: node.type,
    title: node.title,
    order_key: node.orderKey,
    label_id: node.labelId ?? null,
    status_id: node.statusId ?? null,
    trashed_from_parent_id: node.trashedFromParentId ?? null,
    version: node.version,
    created_at: updatedAt,
    updated_at: updatedAt,
  };

  const children = Array.isArray(node.children) ? flattenBinder(node.children, node.id) : [];
  return [flat, ...children];
}
