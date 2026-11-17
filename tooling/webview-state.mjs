// Reads what the app says about its own storage out of a running Android WebView, through
// Chrome DevTools Protocol on a forwarded port (adb forward tcp:PORT localabstract:...).
// Node 22 built-ins only. Prints one JSON object on stdout; always exits 0 unless the
// debugger could not be reached at all, so the caller decides what counts as a failure.
//
//   node tooling/webview-state.mjs [port=9222] [timeoutSeconds=120] [click] [expect]
//
// With `click`, presses the first button with that text once the database is ready. With
// `expect`, waits for that text on the page and reports whether it appeared, as `found`.
const port = process.argv[2] ?? "9222";
const deadline = Date.now() + Number(process.argv[3] ?? 120) * 1000;
const click = process.argv[4] ?? "";
const expect = process.argv[5] ?? "";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const EXPRESSION = `JSON.stringify({
  href: location.href,
  dataset: { ...document.documentElement.dataset },
  hasTauri: "__TAURI_INTERNALS__" in window,
  hasOpfs: typeof navigator.storage?.getDirectory === "function",
  text: (document.body?.innerText ?? "").slice(0, 2000),
})`;

const CLICK = `JSON.stringify({ clicked: (() => {
  const b = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === ${JSON.stringify(click)});
  b?.click();
  return b !== undefined;
})() })`;

async function evaluate(url, expression = EXPRESSION) {
  const ws = new WebSocket(url);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws error")); });
  const reply = new Promise((res) => { ws.onmessage = (m) => res(JSON.parse(m.data)); });
  ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate",
    params: { expression, returnByValue: true } }));
  // A page that never answers must not hang the job; the caller's loop tries again.
  const msg = await Promise.race([
    reply,
    new Promise((_, rej) => setTimeout(() => rej(new Error("no reply from the page")), 10_000)),
  ]).finally(() => ws.close());
  return JSON.parse(msg.result.result.value);
}

let last = null;
let clicked = false;
let failure = "no inspectable page";
while (Date.now() < deadline) {
  try {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
    if (page) {
      last = await evaluate(page.webSocketDebuggerUrl);
      const status = last.dataset.dbStatus;
      if (status === "error" || status === "failed") break;
      if (status === "ready") {
        if (click !== "" && !clicked) clicked = (await evaluate(page.webSocketDebuggerUrl, CLICK)).clicked;
        if (expect === "") {
          if (click === "" || clicked) break;
        } else if (last.text.includes(expect)) {
          last.found = true;
          break;
        }
      }
    }
  } catch (e) {
    failure = String(e);
  }
  await sleep(3000);
}
if (last === null) { console.error(failure); process.exit(1); }
if (expect !== "") last.found ??= false;
if (click !== "") last.clicked = clicked;
console.log(JSON.stringify(last, null, 2));
