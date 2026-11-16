import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../AuthProvider";
import { SignIn } from "../SignIn";
import { SERVERS_STORAGE_KEY, rememberServer } from "../servers";
import { calledUrl, type FetchMock } from "@/test/fetch";

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

const urlOf = (input: Parameters<typeof fetch>[0]) =>
  typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

/** The calls that are not the sign-in screen asking whether registration is open. */
const submitted = (fetcher: FetchMock) =>
  fetcher.mock.calls.filter(([input]) => !urlOf(input).endsWith("/auth/config"));

const config = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

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

    expect(submitted(fetcher)).toHaveLength(1);
    expect(urlOf(submitted(fetcher)[0]![0])).toBe("https://write.example.com/api/v1/auth/login");
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

    expect(urlOf(submitted(fetcher)[0]![0])).toBe("https://write.example.com/api/v1/auth/register");
  });

  it("tells someone who tries to register on a closed server to ask its owner", async () => {
    // A server too old to say whether registration is open still offers the link, and
    // the refusal is where this is discovered.
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ error: "registration_closed" }), { status: 403 }),
      );
    renderSignIn(fetcher);
    await userEvent.click(screen.getByRole("button", { name: /create an account instead/i }));
    await fill();
    await userEvent.click(screen.getByRole("button", { name: "Create account" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/does not accept new accounts/i);
  });

  it("never puts the password anywhere but the request body", async () => {
    const fetcher = renderSignIn();
    await fill();
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));

    const [login] = submitted(fetcher);
    expect(urlOf(login![0])).not.toMatch(/battery/);
    expect(JSON.stringify(JSON.parse(login![1]!.body as string))).toMatch(/battery/);
    // And nothing remembered on this device carries it.
    expect(window.localStorage.getItem(SERVERS_STORAGE_KEY) ?? "").not.toMatch(/battery/);
  });
});

describe("offering to create an account", () => {
  const link = () => screen.queryByRole("button", { name: /create an account instead/i });
  const asked = (fetcher: FetchMock) =>
    fetcher.mock.calls.some(([input]) => urlOf(input) === "https://a.example/api/v1/auth/config");

  it("shows the link while the answer is not in, and when the server says open", async () => {
    remember({ url: "https://a.example", email: null });
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => config({ registrationOpen: true }));
    renderSignIn(fetcher);

    expect(link()).toBeInTheDocument();
    await waitFor(() => expect(asked(fetcher)).toBe(true));
    expect(link()).toBeInTheDocument();
  });

  it("hides the link when the server says registration is closed", async () => {
    remember({ url: "https://a.example", email: null });
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => config({ registrationOpen: false }));
    renderSignIn(fetcher);

    await waitFor(() => expect(link()).not.toBeInTheDocument());
    expect(calledUrl(fetcher)).toBe("https://a.example/api/v1/auth/config");
  });

  it.each([
    ["an older server without the endpoint", () => config({}, 404)],
    ["a server error", () => config({}, 500)],
    ["an answer in an unknown shape", () => config({ registrationOpen: "no" })],
    ["a server that cannot be reached", () => Promise.reject(new TypeError("Failed to fetch"))],
  ])("keeps the link for %s", async (_name, answer) => {
    remember({ url: "https://a.example", email: null });
    const fetcher = vi.fn<typeof fetch>().mockImplementation(answer);
    renderSignIn(fetcher);

    await waitFor(() => expect(asked(fetcher)).toBe(true));
    expect(link()).toBeInTheDocument();
  });

  it("asks again when the server changes, and does not carry one server's answer to another", async () => {
    remember({ url: "https://open.example", email: null }, { url: "https://closed.example", email: null });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation((input) => config({ registrationOpen: !urlOf(input).startsWith("https://closed") }));
    renderSignIn(fetcher);

    // Most recent first, so the closed one is chosen on arrival.
    await waitFor(() => expect(link()).not.toBeInTheDocument());

    await userEvent.selectOptions(screen.getByLabelText("Server"), "https://open.example");
    expect(link()).toBeInTheDocument();
    await waitFor(() =>
      expect(fetcher.mock.calls.some(([input]) => urlOf(input) === "https://open.example/api/v1/auth/config")).toBe(true),
    );
    expect(link()).toBeInTheDocument();
  });

  it("drops back to signing in when the server turns out to be closed", async () => {
    remember({ url: "https://open.example", email: null }, { url: "https://closed.example", email: null });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation((input) => config({ registrationOpen: !urlOf(input).startsWith("https://closed") }));
    renderSignIn(fetcher);

    await userEvent.selectOptions(screen.getByLabelText("Server"), "https://open.example");
    await userEvent.click(link()!);
    expect(screen.getByRole("heading", { name: "Create an account" })).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText("Server"), "https://closed.example");
    await waitFor(() => expect(screen.getByRole("heading", { name: "Sign in" })).toBeInTheDocument());
    expect(link()).not.toBeInTheDocument();
  });
});
