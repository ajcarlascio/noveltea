import { stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// `fileURLToPath`, never `.pathname`: on Windows a file URL's pathname is
// `/D:/a/...` — a leading slash in front of a drive letter — which resolves to
// `D:\D:\a\...` and fails with ENOENT on a path that looks almost right.

const out = fileURLToPath(new URL("../public/thesaurus/wordnet.json", import.meta.url));
const builder = fileURLToPath(new URL("./build-thesaurus.mjs", import.meta.url));

const [outStat, builderStat] = await Promise.all([
  stat(out).catch(() => null),
  stat(builder),
]);

if (outStat !== null && outStat.mtimeMs >= builderStat.mtimeMs) {
  console.log("thesaurus index is up to date");
} else {
  const result = spawnSync(process.execPath, [builder], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
