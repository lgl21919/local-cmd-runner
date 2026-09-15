import express from "express";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const app = express();
app.use(express.json({ limit: "10mb" }));
const PORT = process.env.PORT ? +process.env.PORT : 8151;
const TEMP_DIR = "/tmp/local-cmd-runner-temp";
const execFileAsync = promisify(execFile);

type PuzzleTempRequestBody = {
  source: string;
  name?: string;
};

function validatePuzzleTempBody(body: unknown): PuzzleTempRequestBody | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return null;
  }

  const candidate = body as Record<string, unknown>;
  if (typeof candidate.source !== "string") {
    return null;
  }

  if (candidate.name !== undefined && typeof candidate.name !== "string") {
    return null;
  }

  return {
    source: candidate.source,
    name: candidate.name,
  };
}

function getDetachedTerminalEnv() {
  const env = { ...process.env };

  delete env.KITTY_LISTEN_ON;
  delete env.KITTY_PID;
  delete env.KITTY_WINDOW_ID;
  delete env.TMUX;
  delete env.ZELLIJ;
  delete env.ZELLIJ_SESSION_NAME;

  return env;
}

function openKittyAtDirectory(directory: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("kitty", ["--detach", "--directory", directory], {
      detached: true,
      env: getDetachedTerminalEnv(),
      stdio: "ignore",
    });

    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

async function main() {
  app.post("/puzzletemp", async (req, res) => {
    const body = validatePuzzleTempBody(req.body);
    if (!body) {
      res.status(400).json({
        error: "Invalid request body. Expected { source: string, name?: string }.",
      });
      return;
    }

    await mkdir(TEMP_DIR, { recursive: true });
    const filename = `${randomUUID()}.html`;
    const sourcePath = join(TEMP_DIR, filename);

    try {
      await writeFile(sourcePath, body.source, "utf8");

      const name = body.name ?? `noname-${Date.now()}`;
      const args = ["--name", name, "--cf-source", sourcePath];

      console.log("running command:", "puzzletemp", ...args);
      const { stdout, stderr } = await execFileAsync("puzzletemp", args);

      if (stdout) {
        console.log("puzzletemp stdout:", stdout);
      }
      if (stderr) {
        console.error("puzzletemp stderr:", stderr);
      }

      const createdDirectory = stdout.trim();
      if (!createdDirectory) {
        throw new Error("puzzletemp did not return a created directory");
      }

      await rm(sourcePath, { force: true });

      console.log("opening kitty at:", createdDirectory);
      await openKittyAtDirectory(createdDirectory);

      res.sendStatus(200);
    } catch (error) {
      console.error("puzzletemp failed:", error);
      res.status(500).json({ error: "puzzletemp command failed" });
      await rm(sourcePath, { force: true });
    }
  });
  app.listen(PORT, () => {
    console.log(`app is listening on port ${PORT}`);
  });
}

main();
