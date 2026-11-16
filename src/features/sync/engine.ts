import type { DatabaseClient } from "@/db/client";
import type { RebuildRow } from "@/db/sync-commands";
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
  /** Feed rows the server sent that could not be parsed and were skipped. */
  dropped: number;
  resynced: boolean;
}

export interface SyncDeps {
  db: DatabaseClient;
  auth: Authenticator;
  /** Guards against a pathological server pinning the client in a pull loop. */
  maxPages?: number;
  pageSize?: number;
  /** Called by `adoptServerProjects` once every new row is inserted, before any first sync. */
  onAdopted?: (count: number) => void;
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

/**
 * Brings down the projects this account has on the server and this device does not.
 *
 * Without this a second device signs in and stays empty forever: sync is addressed by
 * project id, so a replica that has never heard of a project has nothing to ask for.
 * Each newly adopted project is synced straight away, so it has its binder by the
 * time anyone opens it; a failure there is left for the project's own scheduler,
 * which treats "never synced" as a reason to try immediately.
 *
 * All rows are inserted first and `onAdopted` fires then, so the list can refresh before
 * the (possibly slow) first syncs run.
 *
 * @returns how many projects were new to this device.
 */
export async function adoptServerProjects(deps: SyncDeps): Promise<number> {
  const response = await deps.auth.fetch("/api/v1/projects");
  const body = await json(response, "list projects");
  if (!Array.isArray(body)) throw new SyncFailed("The server's project list was not readable.");

  const adoptedIds: string[] = [];
  for (const row of body as unknown[]) {
    if (row === null || typeof row !== "object") continue;
    const { id, title, settings } = row as Record<string, unknown>;
    if (typeof id !== "string" || typeof title !== "string" || title.trim() === "") continue;
    const result = await deps.db.command("adoptProject", {
      id,
      title,
      settings: settings !== null && typeof settings === "object" ? JSON.stringify(settings) : null,
    });
    if (!result.adopted) continue;
    adoptedIds.push(id);
  }
  if (adoptedIds.length > 0) deps.onAdopted?.(adoptedIds.length);
  for (const id of adoptedIds) await syncProject(deps, id).catch(() => undefined);
  return adoptedIds.length;
}

export async function syncProject(
  { db, auth, maxPages = 100, pageSize = 200 }: SyncDeps,
  projectId: string,
): Promise<SyncOutcome> {
  const outcome: SyncOutcome = { pulled: 0, pushed: 0, conflicts: [], skipped: [], dropped: 0, resynced: false };

  try {
    const state = await db.command("syncState", { projectId });

    // A locally-created project has never been registered server-side. The server's
    // sync endpoint is scoped by project id in its path and returns 404 for unknown
    // ids, so we must POST the project before attempting any sync.
    if (state.lastSyncedAt === null) {
      const body: Record<string, unknown> = { id: projectId, title: state.title };
      if (state.settings !== null) {
        try { body.settings = JSON.parse(state.settings); } catch { /* use server default */ }
      }
      const reg = await auth.fetch("/api/v1/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!reg.ok && reg.status !== 409) {
        throw new SyncFailed(`Could not register the project with the server (${String(reg.status)}).`);
      }
    }

    let cursor = state.lastChangeId;
    let epoch = state.syncEpoch;

    const pullAll = async () => {
      for (let page = 0; page < maxPages; page += 1) {
        const response = await auth.fetch(
          `/api/v1/projects/${projectId}/sync?since=${String(cursor)}&limit=${String(pageSize)}&epoch=${String(epoch)}`,
        );
        const pull = parsePullResponse(await json(response, "pull changes"));

        if (pull.resyncRequired) {
          // The cursor points into history the server can no longer explain: retention
          // purged it, or the project was restored from an older backup.
          //
          // Rebuilt by converging on the server rather than by wiping first. Deleting
          // everything and re-fetching would open a window in which the author's binder
          // is empty, and would take unpushed local work with it if anything failed
          // partway. Upserting reaches the same state without ever having less than
          // both. The cursor moves in the same transaction, to latestId, not to 0:
          // pulling from 0 would land below the purge point again and ask for a resync
          // forever.
          await rebuildFromServer(db, auth, projectId, pull);
          cursor = pull.latestId;
          epoch = pull.syncEpoch;
          outcome.resynced = true;
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
        outcome.dropped += pull.dropped;
        for (const type of applied.skipped) {
          if (!outcome.skipped.includes(type)) outcome.skipped.push(type);
        }

        cursor = pull.latestId;
        epoch = pull.syncEpoch;
        if (!pull.hasMore) break;
      }
    };

    await pullAll();

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

      await db.command("settlePush", {
        ids,
        sent: pending.map((row) => ({ id: row.id, payload: row.payload })),
        applied: push.applied,
        copies: push.conflicts.flatMap((conflict) =>
          conflict.entityType === "document" && conflict.conflictCopyId !== null
            ? [{ entityId: conflict.entityId, conflictCopyId: conflict.conflictCopyId }]
            : [],
        ),
      });
      outcome.pushed = push.applied.length;
      outcome.conflicts = push.conflicts;

      // A document whose push became a conflict copy still shows this device's text,
      // which a pull keeps while the change is queued. Now that the text is safe in the
      // copy, the server has put its own version back on the feed; taking it straight
      // away keeps the window in which the author could type over a superseded base as
      // short as one round trip.
      if (push.conflicts.some((conflict) => conflict.conflictCopyId !== null)) await pullAll();
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
 * Rebuilds a project from the server after a resync.
 *
 * Everything is fetched first — the rest of the state from `GET /sync/state`, the tree
 * from `GET /binder`, every document body from `GET /documents` — and only then handed
 * to `rebuildProject`, which prunes, applies and moves the cursor in one transaction. A
 * failed request, or the app closing, at any point before that leaves the replica
 * exactly as it was: pruning first and fetching after would leave it gutted, for as long
 * as the device stays offline.
 *
 * `/sync/state` is used only when the resync answer says the server has it, and then any
 * failure of it fails the sync, which retries with the cursor where it was. Guessing
 * from its status instead would take a transient 500 for an older server and rebuild
 * without labels, metadata or comments, never to fetch them again.
 *
 * ponytail: every document body is held in memory until the one write; fine for a
 * novel. Stage pages in a table if a project's prose outgrows the tab's memory.
 */
async function rebuildFromServer(
  db: DatabaseClient,
  auth: Authenticator,
  projectId: string,
  answer: { latestId: number; syncEpoch: number; stateAvailable: boolean },
): Promise<void> {
  const state = answer.stateAvailable ? await fetchState(auth, projectId) : null;

  const response = await auth.fetch(`/api/v1/projects/${projectId}/binder`);
  const binder = flattenBinder(await json(response, "read the binder")).map((node) => ({
    entityType: "binder_item",
    entityId: node.id,
    data: { ...node, project_id: projectId },
  }));

  const documents = await fetchDocumentBodies(auth, projectId);

  await db.command("rebuildProject", {
    projectId,
    state,
    binder,
    documents,
    latestId: answer.latestId,
    syncEpoch: answer.syncEpoch,
  });
}

/**
 * The rows of `GET /sync/state`.
 *
 * A row whose data is unreadable keeps its id with null data: it is not applied, but it
 * is still listed, so the prune does not take it as a row the server has lost.
 */
async function fetchState(auth: Authenticator, projectId: string): Promise<RebuildRow[]> {
  const response = await auth.fetch(`/api/v1/projects/${projectId}/sync/state`);
  const body = await json(response, "read the project's state");
  if (!Array.isArray(body)) throw new SyncFailed("The server's project state was not readable.");

  return (body as unknown[]).flatMap((row) => {
    if (row === null || typeof row !== "object") return [];
    const { entityType, entityId, data } = row as Record<string, unknown>;
    if (typeof entityType !== "string" || typeof entityId !== "string") return [];
    const readable = data !== null && typeof data === "object" && !Array.isArray(data);
    return [{ entityType, entityId, data: readable ? (data as Record<string, unknown>) : null }];
  });
}

/** Walks every page of document bodies. */
async function fetchDocumentBodies(auth: Authenticator, projectId: string): Promise<RebuildRow[]> {
  const rows: RebuildRow[] = [];
  let after: string | null = null;

  // Bounded for the same reason the pull loop is: a server that always says hasMore
  // must not pin the client here forever.
  for (let page = 0; page < 200; page += 1) {
    const query = after === null ? "" : `?after=${encodeURIComponent(after)}`;
    const response = await auth.fetch(`/api/v1/projects/${projectId}/documents${query}`);
    const body = await json(response, "read document bodies");
    if (body === null || typeof body !== "object") break;

    const payload = body as { documents?: unknown; nextCursor?: unknown; hasMore?: unknown };
    const documents = Array.isArray(payload.documents) ? payload.documents : [];

    for (const row of documents) {
      if (row === null || typeof row !== "object") continue;
      const document = row as Record<string, unknown>;
      if (typeof document.id !== "string") continue;
      rows.push({
        entityType: "document",
        entityId: document.id,
        data: {
          id: document.id,
          content: document.content,
          search_text: document.searchText ?? null,
          word_count: typeof document.wordCount === "number" ? document.wordCount : 0,
          version: typeof document.version === "number" ? document.version : 1,
          created_at: document.updatedAt,
          updated_at: document.updatedAt,
        },
      });
    }

    if (payload.hasMore !== true || typeof payload.nextCursor !== "string") break;
    after = payload.nextCursor;
  }
  return rows;
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
