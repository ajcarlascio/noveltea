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
        // both.
        await rebuildFromServer(db, auth, projectId);
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
      outcome.dropped += pull.dropped;
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
 * Every type `GET /sync/state` lists. A type the server listed nothing for still has to
 * be pruned, so this is fixed here rather than read from the rows.
 */
const STATE_TYPES = [
  "taxonomy",
  "custom_metadata_field",
  "collection",
  "compile_preset",
  "custom_metadata_value",
  "collection_item",
  "comment",
  "snapshot",
];

/** State rows that reference a binder item or a document, and so go in after them. */
const NEEDS_BINDER = new Set(["custom_metadata_value", "collection_item", "comment", "snapshot"]);

/**
 * Rebuilds a project from the server after a resync.
 *
 * Five steps, in this order:
 *
 * 1. Everything else the feed carries, from `GET /sync/state`. Rows of those types the
 *    server did not list are removed first, because the replica's unique indexes would
 *    otherwise refuse the server's row while a ghost still holds its place — a value
 *    cleared and set again on another device comes back under a new id for the same
 *    item and field. Then labels, statuses, metadata fields, collections and presets go
 *    in, so the binder items that name them can.
 * 2. The tree, from `GET /binder`.
 * 3. Every document body, from `GET /projects/{id}/documents`, paged. This endpoint
 *    exists only for this: the change feed carries content, but only on rows appended
 *    since a cursor, so a client rebuilding from nothing cannot otherwise recover a
 *    document nobody has edited recently.
 * 4. The rest of the state rows — metadata values, collection items, comments, manual
 *    snapshots — now that what they hang on is here.
 * 5. Binder items the server did not list are removed — otherwise an item deleted while
 *    this client was away, whose delete row retention has since purged, would linger
 *    forever with nothing left to say it is gone.
 *
 * On a server that predates `/sync/state` the rebuild is the tree and the bodies alone,
 * as it was before: those types are then neither restored nor pruned.
 */
async function rebuildFromServer(
  db: DatabaseClient,
  auth: Authenticator,
  projectId: string,
): Promise<void> {
  const state = await fetchState(auth, projectId);
  const stateRows = (needsBinder: boolean) =>
    (state ?? []).flatMap((row) =>
      row.data !== null && NEEDS_BINDER.has(row.entityType) === needsBinder
        ? [{ ...row, data: row.data }]
        : [],
    );

  if (state !== null) {
    const keep: Record<string, string[]> = Object.fromEntries(STATE_TYPES.map((type) => [type, []]));
    for (const row of state) keep[row.entityType]?.push(row.entityId);
    await db.command("pruneMissing", { projectId, keep });
  }
  await applyRows(db, projectId, stateRows(false));

  const response = await auth.fetch(`/api/v1/projects/${projectId}/binder`);
  const flat = flattenBinder(await json(response, "read the binder"));

  await applyRows(
    db,
    projectId,
    flat.map((node) => ({
      entityType: "binder_item",
      entityId: node.id,
      data: { ...node, project_id: projectId },
    })),
  );

  const documentIds = await fetchDocumentBodies(db, auth, projectId);

  await applyRows(db, projectId, stateRows(true));

  await db.command("pruneMissing", {
    projectId,
    keep: { binder_item: [...flat.map((node) => node.id), ...documentIds] },
  });
}

interface Row {
  entityType: string;
  entityId: string;
  data: Record<string, unknown>;
}

/**
 * The rows of `GET /sync/state`, or null from a server too old to have it.
 *
 * Too old means 404 or 500. Servers before this endpoint answer a route they do not have
 * with 500 `internal_error` — their catch-all handler swallows the not-found — and
 * failing on that would fail every rebuild against a server pinned to one, which is
 * worse than the rebuild they always had. The price is that a real 500 here also
 * degrades to it rather than failing the sync.
 *
 * A row whose data is unreadable keeps its id with null data: it is not applied, but it
 * is still listed, so the prune does not take it as a row the server has lost.
 */
async function fetchState(
  auth: Authenticator,
  projectId: string,
): Promise<(Omit<Row, "data"> & { data: Record<string, unknown> | null })[] | null> {
  const response = await auth.fetch(`/api/v1/projects/${projectId}/sync/state`);
  if (response.status === 404 || response.status === 500) return null;
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

/** Walks every page of document bodies, returning the ids it applied. */
async function fetchDocumentBodies(
  db: DatabaseClient,
  auth: Authenticator,
  projectId: string,
): Promise<string[]> {
  const ids: string[] = [];
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

    await applyRows(
      db,
      projectId,
      documents.flatMap((row) => {
        if (row === null || typeof row !== "object") return [];
        const document = row as Record<string, unknown>;
        if (typeof document.id !== "string") return [];
        ids.push(document.id);
        return [
          {
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
          },
        ];
      }),
    );

    if (payload.hasMore !== true || typeof payload.nextCursor !== "string") break;
    after = payload.nextCursor;
  }
  return ids;
}

/** Applies rows without moving the cursor: these did not come from the feed. */
async function applyRows(
  db: DatabaseClient,
  projectId: string,
  rows: Row[],
): Promise<void> {
  if (rows.length === 0) return;
  await db.command("applyPull", {
    projectId,
    changes: rows.map((row, index) => ({ id: index, op: "update", ...row })),
    latestId: 0,
    syncEpoch: 0,
    advanceCursor: false,
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
