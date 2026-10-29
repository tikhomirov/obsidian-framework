import { build } from "esbuild";

await build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  format: "cjs",
  platform: "browser",
  target: "es2022",
  outfile: "main.js",
  external: ["obsidian", "electron", "crypto", "@codemirror/*", "@lezer/*"],
  alias: { "node:crypto": "crypto" },
  sourcemap: false,
  minify: false,
  logLevel: "info",
});
