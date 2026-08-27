import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/features/auth/AuthContext";
import {
  download as downloadFile,
  isTerminal,
  jobStatus,
  listFormats,
  submit,
  type CompileJob,
  type Formats,
} from "./api";

export interface CompileState {
  formats: Formats | null;
  job: CompileJob | null;
  error: string | null;
  busy: boolean;
  /** False without an account: the export pipeline is not on the device. */
  possible: boolean;
  compile: (format: string, destination: string, presetId: string | null) => void;
  download: () => void;
}

/**
 * Submits an export and follows it.
 *
 * Polling rather than a socket, because that is what the server offers and an export
 * is a one-off an author is watching. The interval widens as the wait grows: a short
 * export answers quickly, and a novel-length one should not be asked about every
 * second for two minutes.
 */
export function useCompile(projectId: string): CompileState {
  const { authenticator } = useAuth();
  const [formats, setFormats] = useState<Formats | null>(null);
  const [job, setJob] = useState<CompileJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!authenticator) return;
    let current = true;
    void listFormats(authenticator, projectId).then(
      (next) => {
        if (current) setFormats(next);
      },
      () => {
        // Not surfaced: an author who has not asked to export does not need to be
        // told the format list could not be fetched.
        if (current) setFormats(null);
      },
    );
    return () => {
      current = false;
    };
  }, [authenticator, projectId]);

  const stopPolling = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  useEffect(() => stopPolling, [stopPolling]);

  const poll = useCallback(
    (jobId: string, attempt: number) => {
      if (!authenticator) return;
      // 1s, 2s, 4s… to a ceiling. A short export answers on the first ask.
      const delay = Math.min(1000 * 2 ** attempt, 8000);
      timer.current = setTimeout(() => {
        void jobStatus(authenticator, jobId).then(
          (next) => {
            setJob(next);
            if (isTerminal(next.status)) {
              setBusy(false);
              if (next.status === "failed") {
                setError(next.errorMessage ?? "The export did not finish.");
              }
              return;
            }
            poll(jobId, attempt + 1);
          },
          (cause: unknown) => {
            setBusy(false);
            setError(cause instanceof Error ? cause.message : String(cause));
          },
        );
      }, delay);
    },
    [authenticator],
  );

  const compile = useCallback(
    (format: string, destination: string, presetId: string | null) => {
      if (!authenticator) return;
      stopPolling();
      setError(null);
      setJob(null);
      setBusy(true);

      void submit(authenticator, projectId, format, destination, presetId).then(
        (jobId) => {
          setJob({
            id: jobId, format, destination, status: "queued",
            outputFilename: null, outputBytes: null, wordCount: null,
            warnings: null, errorMessage: null,
          });
          poll(jobId, 0);
        },
        (cause: unknown) => {
          setBusy(false);
          setError(cause instanceof Error ? cause.message : String(cause));
        },
      );
    },
    [authenticator, projectId, poll, stopPolling],
  );

  const download = useCallback(() => {
    if (!authenticator || job === null) return;
    void downloadFile(authenticator, job).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : String(cause));
    });
  }, [authenticator, job]);

  return { formats, job, error, busy, possible: authenticator !== null, compile, download };
}
