import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { AuthProvider } from "@/features/auth/AuthProvider";
import type { Session } from "@/features/auth/session";
import { Users } from "../Users";
import { calledUrl } from "@/test/fetch";

const SESSION: Session = {
  serverUrl: "https://write.example.com",
  userId: "u1",
  deviceId: "d1",
  refreshToken: "r",
  email: "admin@localhost",
  isAdmin: true,
};

/** The JSON body a recorded call was sent with. `init.body` is a union that includes Blob. */
const bodyOf = (init?: RequestInit): unknown =>
  JSON.parse(typeof init?.body === "string" ? init.body : "null");

/** How many recorded calls went to a path, read through the typed URL helper. */
const countCalls = (fetcher: ReturnType<typeof server>, suffix: string): number =>
  fetcher.mock.calls.filter((_, index) => calledUrl(fetcher, index).endsWith(suffix)).length;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const USERS = [
  {
    id: "u1",
    email: "admin@localhost",
    displayName: "Administrator",
    admin: true,
    guest: false,
    mustChangePassword: false,
    createdAt: "2026-08-27T00:00:00Z",
    deletionRequestedAt: null,
  },
  {
    id: "u2",
    email: "newcomer@example.com",
    displayName: null,
    admin: false,
    guest: false,
    mustChangePassword: true,
    createdAt: "2026-08-27T01:00:00Z",
    deletionRequestedAt: null,
  },
];

/**
 * Routes by URL rather than by call order.
 *
 * A restored session has no access token in memory, so a refresh goes out before
 * anything else — and ordering the doubles by hand would make these tests about that
 * rather than about the screen.
 */
function server(handlers: { users?: () => Response; create?: () => Response; reset?: () => Response }) {
  return vi.fn<typeof fetch>().mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.endsWith("/auth/refresh")) {
      return Promise.resolve(
        json({ userId: "u1", deviceId: "d1", accessToken: "a", refreshToken: "r", expiresIn: 900 }),
      );
    }
    if (url.endsWith("/password")) {
      return Promise.resolve(handlers.reset?.() ?? json({ id: "u2", email: "x@y.test", password: "RESET-PW" }));
    }
    if (url.endsWith("/admin/users") && init?.method === "POST") {
      return Promise.resolve(
        handlers.create?.() ?? json({ id: "u3", email: "someone@example.com", password: "MADE-UP-PW" }, 201),
      );
    }
    return Promise.resolve(handlers.users?.() ?? json(USERS));
  });
}

function renderUsers(fetcher = server({}), session: Session | null = SESSION) {
  render(
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <AuthProvider initialSession={session} fetcher={fetcher}>
        <Users />
      </AuthProvider>
    </MemoryRouter>,
  );
  return fetcher;
}

describe("the account list", () => {
  it("renders before the list arrives, because the interface never waits on the network", async () => {
    renderUsers();
    // The form is usable on the first paint; the list fills in behind it.
    expect(screen.getByRole("heading", { name: "Accounts" })).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(await screen.findByText("newcomer@example.com")).toBeInTheDocument();
  });

  it("marks who administers the server and who has not chosen a password", async () => {
    renderUsers();
    await screen.findByText("admin@localhost");
    expect(screen.getByText("administrator")).toBeInTheDocument();
    expect(screen.getByText("has not chosen a password")).toBeInTheDocument();
  });

  it("says the list could not be read rather than showing an empty server", async () => {
    // An instance with no accounts is impossible — there is always an administrator — so
    // rendering nothing would be a lie about what happened.
    renderUsers(server({ users: () => json({ error: "not_found" }, 404) }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/does not administer|older/i);
    expect(screen.getByText(/could not read the account list/i)).toBeInTheDocument();
  });

  it("sends someone who is not signed in to sign in", () => {
    renderUsers(server({}), null);
    expect(screen.getByRole("link", { name: "Sign in" })).toBeInTheDocument();
  });
});

describe("adding someone", () => {
  it("shows the generated password once, and says it cannot be shown again", async () => {
    renderUsers();
    await screen.findByText("newcomer@example.com");

    await userEvent.type(screen.getByLabelText("Email"), "someone@example.com");
    await userEvent.type(screen.getByLabelText("Display name"), "Someone");
    await userEvent.click(screen.getByRole("button", { name: "Create account" }));

    expect(await screen.findByText("MADE-UP-PW")).toBeInTheDocument();
    expect(screen.getByText(/keeps only a hash of it and cannot show it again/i)).toBeInTheDocument();
  });

  it("clears the form after, so the next one does not inherit the last address", async () => {
    renderUsers();
    await screen.findByText("newcomer@example.com");

    await userEvent.type(screen.getByLabelText("Email"), "someone@example.com");
    await userEvent.click(screen.getByRole("button", { name: "Create account" }));
    await screen.findByText("MADE-UP-PW");

    expect(screen.getByLabelText("Email")).toHaveValue("");
  });

  it("reports a refusal and keeps what was typed", async () => {
    renderUsers(server({ create: () => json({ error: "email_registered" }, 409) }));
    await screen.findByText("newcomer@example.com");

    await userEvent.type(screen.getByLabelText("Email"), "taken@example.com");
    await userEvent.click(screen.getByRole("button", { name: "Create account" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/already has an account/i);
    expect(screen.getByLabelText("Email")).toHaveValue("taken@example.com");
  });

  it("asks the server to make the new account an administrator when told to", async () => {
    const fetcher = renderUsers();
    await screen.findByText("newcomer@example.com");

    await userEvent.type(screen.getByLabelText("Email"), "second@example.com");
    await userEvent.click(screen.getByLabelText("Can administer this server"));
    await userEvent.click(screen.getByRole("button", { name: "Create account" }));
    await screen.findByText("MADE-UP-PW");

    // By URL as well as method: the refresh that precedes everything is also a POST.
    // Matched on the URL as well as the method: the refresh that precedes everything
    // is also a POST.
    const index = fetcher.mock.calls.findIndex(
      ([, init], at) => init?.method === "POST" && calledUrl(fetcher, at).endsWith("/admin/users"),
    );
    expect(bodyOf(fetcher.mock.calls[index]?.[1])).toMatchObject({ admin: true });
  });
});

describe("setting a password for somebody locked out", () => {
  it("shows the new password once, for an instance with no mail server to send it", async () => {
    renderUsers();
    await screen.findByText("newcomer@example.com");

    await userEvent.click(screen.getAllByRole("button", { name: "Set a password" })[1]!);

    expect(await screen.findByText("RESET-PW")).toBeInTheDocument();
  });

  it("reloads the list, because the account now has to choose its own", async () => {
    const fetcher = renderUsers();
    await screen.findByText("newcomer@example.com");
    const before = countCalls(fetcher, "/admin/users");

    await userEvent.click(screen.getAllByRole("button", { name: "Set a password" })[0]!);
    await screen.findByText("RESET-PW");

    await waitFor(() =>
      expect(
        countCalls(fetcher, "/admin/users"),
      ).toBeGreaterThan(before),
    );
  });
});
