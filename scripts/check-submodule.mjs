import { existsSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";

/**
 * The schema and migration runner come from the server repo, pinned as a git
 * submodule. A plain `git clone` leaves that directory empty, and the failure that
 * follows is an npm workspace resolution error that says nothing about submodules.
 * This says what to run instead.
 */
const marker = fileURLToPath(
  new URL("../vendor/noveltea-server/packages/client-db/package.json", import.meta.url),
);

if (!existsSync(marker)) {
  console.error(
    [
      "",
      "  The vendored server repo is missing.",
      "",
      "  @noveltea/client-db supplies this client's SQLite schema and migrations, and it",
      "  lives in the server repository, pinned here as a git submodule. Fetch it with:",
      "",
      "      git submodule update --init --recursive",
      "",
      "  then run npm install again.",
      "",
    ].join("\n"),
  );
  process.exit(1);
}
