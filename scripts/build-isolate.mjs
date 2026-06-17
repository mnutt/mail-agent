import { build } from "esbuild";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const entry = process.argv[2] || "src/worker.ts";
const outfile = process.argv[3] || "dist/worker.js";

await mkdir(dirname(outfile), { recursive: true });

await build({
  entryPoints: [resolve(entry)],
  outfile,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  external: ["sandstorm:api", "sandstorm:rpc", "capnweb"],
  sourcemap: true,
});
