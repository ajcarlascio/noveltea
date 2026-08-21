import { vi } from "vitest";
import type { WorkerLike } from "@/db/client";
import type { DbRequest, WorkerOutbound } from "@/db/protocol";

/**
 * A worker double. Nothing that matters about the client is observable with a real
 * worker: the behaviours worth testing are what happens when one crashes, answers
 * out of order, or never opens the database, and a real one cannot be asked to.
 */
export function fakeWorker() {
  const sent: DbRequest[] = [];
  const messageListeners: ((event: MessageEvent<WorkerOutbound>) => void)[] = [];
  const errorListeners: ((event: ErrorEvent) => void)[] = [];
  const terminate = vi.fn();

  const worker: WorkerLike = {
    postMessage: (message) => void sent.push(message),
    addEventListener: (type: string, listener: unknown) => {
      if (type === "message")
        messageListeners.push(listener as (event: MessageEvent<WorkerOutbound>) => void);
      else errorListeners.push(listener as (event: ErrorEvent) => void);
    },
    terminate,
  };

  return {
    worker,
    sent,
    terminate,
    reply(message: WorkerOutbound) {
      for (const listener of messageListeners) {
        listener({ data: message } as MessageEvent<WorkerOutbound>);
      }
    },
    /** Answer whatever is outstanding, so a component's read resolves. */
    answerAll(result: unknown = []) {
      for (const request of sent.splice(0, sent.length)) {
        this.reply({ id: request.id, ok: true, result });
      }
    },
    crash(message = "worker died") {
      for (const listener of errorListeners) listener({ message } as ErrorEvent);
    },
  };
}
