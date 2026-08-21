import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../AuthProvider";
import { SignIn } from "../SignIn";
import { SERVERS_STORAGE_KEY, rememberServer } from "../servers";
import { calledBody, calledUrl, type FetchMock } from "@/test/fetch";

const okSession = () =>
  Promise.resolve(
    new Response(
      JSON.stringify({
        userId: "u1",
        deviceId: "d1",
        accessToken: "a",
        refreshToken: "r",
        expiresIn: 900,
      }),
      { status: 200 },
    ),
  );

function renderSignIn(fetcher: FetchMock = vi.fn<typeof fetch>().mockImplementation(okSession)) {
  render(
    <AuthProvider initialSession={null} fetcher={fetcher}>
      <SignIn />
    </AuthProvider>,
  );
  return fetcher;
}

function remember(...servers: { url: string; email: string | null }[]) {
  let list: ReturnType<typeof rememberServer> = [];
  for (const server of servers) list = rememberServer(list, server.url, server.email);
  window.localStorage.setItem(SERVERS_STORAGE_KEY, JSON.stringify(list));
}

beforeEach(() => window.localStorage.clear());
afterEach(() => window.localStorage.clear());

describe("choosing a server", () => {
  it("asks for an address when none is remembered", () => {
    renderSignIn();
    // No default instance exists, so this is the first thing asked rather than
    // something hidden in settings.
    expect(screen.getByLabelText("Server address")).toBeInTheDocument();
    expect(screen.queryByLabelText("Server")).not.toBeInTheDocument();
  });

  it("offers remembered servers, most recent first", () => {
    remember({ url: "https://old.example", email: "me@old" }, { url: "https://new.example", email: "me@new" });
    renderSignIn();

    const options = screen.getAllByRole("option").map((o) => o.textContent);
    expect(options.slice(0, 2)).toEqual(["https://new.example", "https://old.example"]);
  });

  it("prefills the address last used there", () => {
    remember({ url: "https://a.example", email: "me@a" });
    renderSignIn();
    expect(screen.getByLabelText("Email")).toHaveValue("me@a");
  });

  it("swaps the email when another remembered server is chosen", async () => {
    remember({ url: "https://a.example", email: "me@a" }, { url: "https://b.example", email: "me@b" });
    renderSignIn();

    await userEvent.selectOptions(screen.getByLabelText("Server"), "https://a.example");
    expect(screen.getByLabelText("Email")).toHaveValue("me@a");
  });

  it("reveals a text field for a server not in the list", async () => {
    remember({ url: "https://a.example", email: null });
    renderSignIn();
    expect(screen.queryByLabelText("Server address")).not.toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText("Server"), "Another server");
    expect(screen.getByLabelText("Server address")).toBeInTheDocument();
  });
});

describe("warning about plain HTTP", () => {
  it("warns for a remote address", async () => {
    renderSignIn();
    await userEvent.type(screen.getByLabelText("Server address"), "http://write.example.com");
    expect(screen.getByRole("alert")).toHaveTextContent(/not encrypted/i);
  });

  it("stays quiet for a server on this machine", async () => {
    // Every development server is plain HTTP on localhost. Crying wolf there trains
    // people to ignore the warning that matters.
    renderSignIn();
    await userEvent.type(screen.getByLabelText("Server address"), "http://localhost:8080");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("submitting", () => {
  const fill = async (server = "write.example.com") => {
    await userEvent.type(screen.getByLabelText("Server address"), server);
    await userEvent.type(screen.getByLabelText("Email"), "author@example.com");
    await userEvent.type(screen.getByLabelText("Password"), "correct horse battery staple");
  };

  it("posts to the address the author gave", async () => {
    const fetcher = renderSignIn();
    await fill();
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(calledUrl(fetcher)).toBe("https://write.example.com/api/v1/auth/login");
  });

  it("refuses an address that is not a server, without calling out", async () => {
    const fetcher = renderSignIn();
    await userEvent.type(screen.getByLabelText("Server address"), "javascript:alert(1)");
    await userEvent.type(screen.getByLabelText("Email"), "a@b.com");
    await userEvent.type(screen.getByLabelText("Password"), "x");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(screen.getByRole("alert")).toHaveTextContent(/https:\/\/ or http:\/\//i);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("reports a rejected sign-in without saying which half was wrong", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ code: "invalid_credentials" }), { status: 401 }));
    renderSignIn(fetcher);
    await fill();
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/do not match an account/i);
  });

  it("explains an unreachable server, including the CORS case", async () => {
    // The failure a self-hoster actually hits, and the one that looks least like
    // what it is.
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("Failed to fetch"));
    renderSignIn(fetcher);
    await fill();
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/cors\.allowed-origins/i);
  });

  it("creates an account through the other route", async () => {
    const fetcher = renderSignIn();
    await userEvent.click(screen.getByRole("button", { name: /create an account instead/i }));
    await fill();
    await userEvent.click(screen.getByRole("button", { name: "Create account" }));

    expect(calledUrl(fetcher)).toBe("https://write.example.com/api/v1/auth/register");
  });

  it("never puts the password anywhere but the request body", async () => {
    const fetcher = renderSignIn();
    await fill();
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(calledUrl(fetcher)).not.toMatch(/battery/);
    expect(JSON.stringify(calledBody(fetcher))).toMatch(/battery/);
    // And nothing remembered on this device carries it.
    expect(window.localStorage.getItem(SERVERS_STORAGE_KEY) ?? "").not.toMatch(/battery/);
  });
});
