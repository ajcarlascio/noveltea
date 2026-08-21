import { vi, type Mock } from "vitest";

/**
 * A typed `fetch` double.
 *
 * `vi.fn()` on its own produces `any`, which then spreads through every assertion
 * that reads a call — so the tests stop checking anything the compiler could have
 * caught. Typing it once here keeps that honest.
 */
export type FetchMock = Mock<typeof fetch>;

export function fetchMock(...responses: (() => Promise<Response>)[]): FetchMock {
  const mock = vi.fn<typeof fetch>();
  if (responses.length === 1) mock.mockImplementation(responses[0]!);
  else for (const response of responses) mock.mockImplementationOnce(response);
  return mock;
}

/** The URL a recorded call was sent to. fetch accepts three shapes; two occur here. */
export function calledUrl(mock: FetchMock, index = 0): string {
  const input = mock.mock.calls[index]?.[0];
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  if (input !== undefined) return input.url;
  throw new Error(`fetch was not called ${String(index + 1)} time(s)`);
}

/** The init a recorded call was sent with. */
export function calledInit(mock: FetchMock, index = 0): RequestInit {
  return mock.mock.calls[index]?.[1] ?? {};
}

/** The JSON body a recorded call carried. */
export function calledBody(mock: FetchMock, index = 0): unknown {
  const body = calledInit(mock, index).body;
  return typeof body === "string" ? JSON.parse(body) : null;
}
