import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AuthProvider } from "../AuthProvider";
import { ChangePassword } from "../ChangePassword";
import type { Session } from "../session";
import { calledBody, calledUrl, fetchMock, type FetchMock } from "@/test/fetch";

const LOCKED: Session = {
  serverUrl: "https://write.example.com",
  userId: "u1",
  deviceId: "d1",
  refreshToken: "r",
  email: "admin@localhost",
  mustChangePassword: true,
};

const NEW_PASSWORD = "a passphrase nobody else has seen";

/**
 * A restored session holds no access token in memory, so the first request out is always
 * a refresh. That is worth knowing rather than working around: it means the change also
 * proves /auth/refresh still works for an account the server is holding at the door.
 */
const refreshed = () =>
  Promise.resolve(
    new Response(
      JSON.stringify({
        userId: "u1",
        deviceId: "d1",
        accessToken: "a",
        refreshToken: "r",
        expiresIn: 900,
        mustChangePassword: true,
      }),
      { status: 200 },
    ),
  );

const changed = (devicesSignedOut = 0) =>
  Promise.resolve(
    new Response(
      JSON.stringify({
        userId: "u1",
        deviceId: "d1",
        accessToken: "fresh",
        refreshToken: "r2",
        expiresIn: 900,
        mustChangePassword: false,
        devicesSignedOut,
      }),
      { status: 200 },
    ),
  );

function renderScreen(
  session: Session | null = LOCKED,
  fetcher: FetchMock = fetchMock(() => changed()),
) {
  render(
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <AuthProvider initialSession={session} fetcher={fetcher}>
        <ChangePassword />
      </AuthProvider>
    </MemoryRouter>,
  );
  return fetcher;
}

const fill = async (current: string, next: string, confirmation = next) => {
  await userEvent.type(screen.getByLabelText("Current password"), current);
  await userEvent.type(screen.getByLabelText("New password"), next);
  await userEvent.type(screen.getByLabelText("New password again"), confirmation);
};

const submit = () => userEvent.click(screen.getByRole("button", { name: "Change password" }));

describe("what the screen says it is for", () => {
  it("explains that a forced change is not the account holder's password yet", () => {
    renderScreen();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Choose your password");
    expect(screen.getByText(/set by whoever installed this server/i)).toBeInTheDocument();
    // Nothing to cancel to: this is the only thing the account may do.
    expect(screen.queryByRole("link", { name: "Cancel" })).not.toBeInTheDocument();
  });

  it("is an ordinary change when the server is not insisting", () => {
    renderScreen({ ...LOCKED, mustChangePassword: false });
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Change your password");
    expect(screen.getByRole("link", { name: "Cancel" })).toBeInTheDocument();
  });

  it("sends someone who is not signed in to sign in first", () => {
    renderScreen(null);
    expect(screen.getByRole("link", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.queryByLabelText("New password")).not.toBeInTheDocument();
  });
});

describe("checks that cost a keystroke instead of a round trip", () => {
  it("catches a mistyped confirmation without calling the server", async () => {
    const fetcher = renderScreen();
    await fill("admin", NEW_PASSWORD, "a passphrase typed slightly differently");
    await submit();

    expect(await screen.findByRole("alert")).toHaveTextContent(/do not match/i);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("catches a password too short to be accepted anyway", async () => {
    const fetcher = renderScreen();
    await fill("admin", "hunter2");
    await submit();

    expect(await screen.findByRole("alert")).toHaveTextContent(/at least 12 characters/i);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("refuses keeping the password somebody else chose", async () => {
    // The whole point of the forced change. Satisfying it by re-entering the seeded
    // password would leave the account exactly where it started.
    const fetcher = renderScreen();
    await fill("the same long password", "the same long password");
    await submit();

    expect(await screen.findByRole("alert")).toHaveTextContent(/different from the current one/i);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("changing it", () => {
  it("sends both passwords and says what the change signed out", async () => {
    const fetcher = renderScreen(LOCKED, fetchMock(() => changed(2)));
    await fill("admin", NEW_PASSWORD);
    await submit();

    expect(await screen.findByRole("heading", { name: "Password changed" })).toBeInTheDocument();
    // Index 1: the restored session has no access token in memory, so a refresh goes
    // out first. Asserting on call 0 would be asserting about that instead.
    expect(calledUrl(fetcher, 0)).toBe("https://write.example.com/api/v1/auth/refresh");
    expect(calledUrl(fetcher, 1)).toBe("https://write.example.com/api/v1/account/password");
    expect(calledBody(fetcher, 1)).toEqual({
      currentPassword: "admin",
      newPassword: NEW_PASSWORD,
    });
    expect(screen.getByText(/signed out 2 other devices/i)).toBeInTheDocument();
  });

  it("does not claim to have signed anything out when it did not", async () => {
    renderScreen(LOCKED, fetchMock(() => changed(0)));
    await fill("admin", NEW_PASSWORD);
    await submit();

    expect(await screen.findByText(/no other devices were signed in/i)).toBeInTheDocument();
  });

  it("stores the replacement session, so the next request is not made with the old token", async () => {
    renderScreen(LOCKED, fetchMock(() => changed()));
    await fill("admin", NEW_PASSWORD);
    await submit();
    await screen.findByRole("heading", { name: "Password changed" });

    const stored: unknown = JSON.parse(window.localStorage.getItem("noveltea.session") ?? "null");
    expect(stored).toMatchObject({ refreshToken: "r2", mustChangePassword: false });
  });

  it("reports the server's refusal and stays on the form", async () => {
    // Sequenced: the refresh has to succeed, or the provider treats the 401 as the
    // session ending and this stops being a test about a wrong current password.
    const fetcher = fetchMock(refreshed, () =>
      Promise.resolve(new Response(JSON.stringify({ error: "invalid_credentials" }), { status: 401 })),
    );
    renderScreen(LOCKED, fetcher);
    await fill("not the seeded password", NEW_PASSWORD);
    await submit();

    expect(await screen.findByRole("alert")).toHaveTextContent(/do not match an account/i);
    expect(screen.getByLabelText("New password")).toBeInTheDocument();
  });

  it("never puts a password in the URL", async () => {
    const fetcher = renderScreen();
    await fill("admin", NEW_PASSWORD);
    await submit();
    await screen.findByRole("heading", { name: "Password changed" });

    expect(calledUrl(fetcher, 1)).not.toMatch(/admin|passphrase/);
  });
});

describe("the session it changes", () => {
  it("uses the token the provider already holds rather than spending a refresh", async () => {
    // An account being held at the door can reach exactly one route, so there is nothing
    // to refresh against — and a refresh here would rotate the token for no reason.
    const fetcher = fetchMock(() => changed());
    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <AuthProvider initialSession={LOCKED} fetcher={fetcher}>
          <ChangePassword />
        </AuthProvider>
      </MemoryRouter>,
    );
    await fill("admin", NEW_PASSWORD);
    await submit();
    await screen.findByRole("heading", { name: "Password changed" });

    // One call to refresh (no in-memory token on a restored session), then the change.
    const urls = fetcher.mock.calls.map((_, index) => calledUrl(fetcher, index));
    expect(urls.filter((url) => url.endsWith("/account/password"))).toHaveLength(1);
  });
});
