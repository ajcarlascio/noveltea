import { stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const out = new URL("../public/thesaurus/wordnet.json", import.meta.url).pathname;
const builder = new URL("./build-thesaurus.mjs", import.meta.url).pathname;

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
