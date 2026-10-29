// Single-file bundle of of-worker for the PC (no node_modules needed there).
import { build } from "esbuild";

await build({
  entryPoints: [new URL("./src/main.ts", import.meta.url).pathname],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: new URL("./dist-bundle/of-worker.mjs", import.meta.url).pathname,
  banner: { js: "import { createRequire as __cr } from \"node:module\"; const require = __cr(import.meta.url);" },
  logLevel: "info",
});
