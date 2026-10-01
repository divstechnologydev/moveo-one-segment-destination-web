import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs", "iife"],
  // Global exposed by the script-tag build (dist/index.global.js).
  globalName: "MoveoOneSegment",
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  target: "es2020",
  esbuildOptions(options, { format }) {
    // Minify only the script-tag build; ESM/CJS output stays unchanged.
    if (format === "iife") options.minify = true;
  },
});
