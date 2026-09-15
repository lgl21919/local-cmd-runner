import { chmod } from "node:fs/promises";
import { build } from "esbuild";

const outfile = "dist/local-cmd-runner.js";

await build({
  entryPoints: ["index.ts"],
  outfile,
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  banner: {
    js: "#!/usr/bin/env node",
  },
});

await chmod(outfile, 0o755);
