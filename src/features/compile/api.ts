import type { Authenticator } from "@/features/auth/authenticate";

/**
 * Compiling a manuscript.
 *
 * The work happens on the server: it queues a job, a worker renders it, and the
 * client polls. Nothing here is offline — this is the one thing in the app that
 * genuinely cannot be done without a server, because the export pipeline is not on
 * the device.
 */

export const TERMINAL_STATUSES = ["done", "failed"] as const;
export type JobStatus = "queued" | "running" | "done" | "failed";

export interface CompileJob {
  id: string;
  format: string;
  destination: string;
  status: JobStatus;
  outputFilename: string | null;
  outputBytes: number | null;
  wordCount: number | null;
  warnings: unknown;
  errorMessage: string | null;
}

export interface Formats {
  supported: string[];
  /**
   * Reported rather than hidden. This is an open-core product: a format missing from
   * a Core build is an upgrade, not a thing that does not exist, and pretending
   * otherwise would make the interface lie about what the software can do.
   */
  unavailable: string[];
}

export class CompileFailed extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
    this.name = "CompileFailed";
  }
}

async function read(response: Response, what: string): Promise<unknown> {
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { code?: unknown; message?: unknown };
    const code = typeof body.code === "string" ? body.code : undefined;

    if (response.status === 501 || code === "unavailable_in_this_edition") {
      throw new CompileFailed(
        "That format is not part of this edition of NovelTea. Your writing is unaffected — it is the export that needs an upgrade.",
        "unavailable_in_this_edition",
      );
    }
    if (response.status === 429 || code === "too_many_pending_compiles") {
      throw new CompileFailed(
        "There are already several exports waiting. Let one finish and try again.",
        code,
      );
    }
    const message = typeof body.message === "string" ? body.message : "";
    throw new CompileFailed(
      message.length > 0 ? message : `The server could not ${what} (${String(response.status)}).`,
      code,
    );
  }
  return response.json();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

export async function listFormats(auth: Authenticator, projectId: string): Promise<Formats> {
  const raw = await read(
    await auth.fetch(`/api/v1/projects/${projectId}/compile/formats`),
    "list formats",
  );
  const body = isRecord(raw) ? raw : {};
  const strings = (value: unknown) =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  return { supported: strings(body.supported), unavailable: strings(body.unavailable) };
}

export async function submit(
  auth: Authenticator,
  projectId: string,
  format: string,
  destination: string,
): Promise<string> {
  const raw = await read(
    await auth.fetch(`/api/v1/projects/${projectId}/compile`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ format, destination }),
    }),
    "start the export",
  );
  const id = isRecord(raw) ? raw.id : null;
  if (typeof id !== "string") {
    throw new CompileFailed("The server did not say which job it started.");
  }
  return id;
}

export async function jobStatus(auth: Authenticator, jobId: string): Promise<CompileJob> {
  const raw = await read(await auth.fetch(`/api/v1/compile-jobs/${jobId}`), "check the export");
  const body = isRecord(raw) ? raw : {};
  const text = (value: unknown) => (typeof value === "string" ? value : null);
  const num = (value: unknown) => (typeof value === "number" ? value : null);

  return {
    id: text(body.id) ?? jobId,
    format: text(body.format) ?? "",
    destination: text(body.destination) ?? "",
    // An unrecognised status is treated as still running rather than as finished:
    // reporting "done" for something that is not would offer a download of nothing.
    status: isJobStatus(body.status) ? body.status : "running",
    outputFilename: text(body.outputFilename),
    outputBytes: num(body.outputBytes),
    wordCount: num(body.wordCount),
    warnings: body.warnings ?? null,
    errorMessage: text(body.errorMessage),
  };
}

function isJobStatus(value: unknown): value is JobStatus {
  return value === "queued" || value === "running" || value === "done" || value === "failed";
}

export function isTerminal(status: JobStatus): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

/**
 * Fetches the finished file.
 *
 * Not a plain link: the download route needs a bearer token, and an `<a href>` sends
 * no headers. The bytes are fetched, turned into a blob URL, handed to the browser as
 * a download, and the URL revoked — leaving it alive would pin the whole manuscript
 * in memory for as long as the tab is open.
 */
/** Exactly what the download needs from an anchor, and nothing more. */
export interface DownloadLink {
  href: string;
  download: string;
  click: () => void;
}

export async function download(
  auth: Authenticator,
  job: CompileJob,
  createLink: () => DownloadLink = () => document.createElement("a"),
): Promise<void> {
  const response = await auth.fetch(`/api/v1/compile-jobs/${job.id}/download`);
  if (!response.ok) {
    throw new CompileFailed(
      `The finished file could not be fetched (${String(response.status)}). Exports expire; you may need to compile again.`,
    );
  }

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  try {
    const link = createLink();
    link.href = url;
    link.download = job.outputFilename ?? `manuscript.${job.format}`;
    link.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}
