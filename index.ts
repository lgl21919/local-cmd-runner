import express from "express";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

const app = express();
app.use(express.json({ limit: "10mb" }));

const PORT = process.env.PORT ? +process.env.PORT : 8151;
const HOST = process.env.HOST?.trim() || "127.0.0.1";
const IS_WINDOWS = process.platform === "win32";
const OPEN_BROWSER = process.env.LOCAL_CMD_RUNNER_OPEN_BROWSER !== "0";
const DEFAULT_CWD = resolveConfiguredDirectory(
  process.env.LOCAL_CMD_RUNNER_CWD,
  process.cwd(),
);
const COMMAND_TIMEOUT_MS = process.env.LOCAL_CMD_RUNNER_TIMEOUT_MS
  ? +process.env.LOCAL_CMD_RUNNER_TIMEOUT_MS
  : 60_000;
const HISTORY_OUTPUT_LIMIT = 200_000;
const execFileAsync = promisify(execFile);
const PUBLIC_DIR = join(__dirname, "public");
const DATE_FOLDER_RE = /^\d{4}-\d{2}-\d{2}$/;
const HISTORY_ID_RE = /^[0-9a-f-]{36}$/i;

type PuzzleTempRequestBody = {
  source: string;
  name?: string;
  /** Optional override for the temp directory used for this request. */
  tempDir?: string;
};

type RunCommandRequestBody = {
  command: string;
  cwd?: string;
};

type HistoryEntry = {
  id: string;
  date: string;
  executedAt: string;
  command: string;
  cwd: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  error?: string;
};

type HistoryListItem = {
  id: string;
  date: string;
  executedAt: string;
  command: string;
  cwd: string;
  exitCode: number;
  durationMs: number;
  error?: string;
  preview: string;
};

function resolveConfiguredDirectory(
  value: string | undefined,
  fallback: string,
): string {
  const raw = value?.trim();
  if (!raw) {
    return fallback;
  }

  if (raw === "~") {
    return homedir();
  }

  if (raw.startsWith("~/") || raw.startsWith("~\\")) {
    return join(homedir(), raw.slice(2));
  }

  return isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
}

const DEFAULT_TEMP_DIR = join(tmpdir(), "local-cmd-runner-temp");
const TEMP_DIR = resolveConfiguredDirectory(
  process.env.LOCAL_CMD_RUNNER_TEMP_DIR ?? process.env.TEMP_DIR,
  DEFAULT_TEMP_DIR,
);
const HISTORY_DIR = resolveConfiguredDirectory(
  process.env.LOCAL_CMD_RUNNER_HISTORY_DIR,
  resolve(process.cwd(), "history"),
);
const RECENT_CWDS_FILE = join(HISTORY_DIR, "recent-cwds.json");
const RECENT_CWDS_LIMIT = 10;

function formatDateFolder(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function truncateText(value: string, limit = HISTORY_OUTPUT_LIMIT): string {
  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, limit)}\n… [truncated ${value.length - limit} chars]`;
}

function buildPreview(entry: Pick<HistoryEntry, "stdout" | "stderr" | "error">) {
  if (entry.error) {
    return entry.error;
  }
  const text = (entry.stdout || entry.stderr || "").trim();
  if (!text) {
    return "(无输出)";
  }
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}

function toListItem(entry: HistoryEntry): HistoryListItem {
  return {
    id: entry.id,
    date: entry.date,
    executedAt: entry.executedAt,
    command: entry.command,
    cwd: entry.cwd,
    exitCode: entry.exitCode,
    durationMs: entry.durationMs,
    error: entry.error,
    preview: buildPreview(entry),
  };
}

async function readRecentCwds(): Promise<string[]> {
  try {
    const raw = await readFile(RECENT_CWDS_FILE, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      .map((item) => item.trim());
  } catch {
    return [];
  }
}

function normalizeCwdPath(cwd: string): string {
  const trimmed = cwd.trim();
  if (!trimmed) {
    return "";
  }

  // Keep drive roots like "D:\", strip other trailing separators.
  if (/^[a-zA-Z]:[\\/]$/.test(trimmed) || trimmed === "/" || trimmed === "\\") {
    return trimmed.length === 1 ? trimmed : `${trimmed[0]}:\\`;
  }

  return trimmed.replace(/[\\/]+$/, "");
}

async function rememberCwd(cwd: string): Promise<string[]> {
  const normalized = normalizeCwdPath(cwd);
  if (!normalized) {
    return readRecentCwds();
  }

  const existing = (await readRecentCwds()).map(normalizeCwdPath).filter(Boolean);
  const next = [
    normalized,
    ...existing.filter(
      (item) => item.toLowerCase() !== normalized.toLowerCase(),
    ),
  ].slice(0, RECENT_CWDS_LIMIT);

  await mkdir(HISTORY_DIR, { recursive: true });
  await writeFile(RECENT_CWDS_FILE, JSON.stringify(next, null, 2), "utf8");
  return next;
}

async function listRecentCwds(): Promise<string[]> {
  const storedRaw = await readRecentCwds();
  const stored: string[] = [];
  const seen = new Set<string>();
  for (const item of storedRaw) {
    const cwd = normalizeCwdPath(item);
    const key = cwd.toLowerCase();
    if (!cwd || seen.has(key)) {
      continue;
    }
    seen.add(key);
    stored.push(cwd);
  }

  if (stored.length >= RECENT_CWDS_LIMIT) {
    return stored.slice(0, RECENT_CWDS_LIMIT);
  }

  // Backfill from history files if the dedicated list is still short.
  const merged = [...stored];
  const groups = await listHistory("");

  for (const group of groups) {
    for (const entry of group.entries) {
      const cwd = normalizeCwdPath(entry.cwd ?? "");
      if (!cwd) {
        continue;
      }
      const key = cwd.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      merged.push(cwd);
      if (merged.length >= RECENT_CWDS_LIMIT) {
        break;
      }
    }
    if (merged.length >= RECENT_CWDS_LIMIT) {
      break;
    }
  }

  const result = merged.slice(0, RECENT_CWDS_LIMIT);
  if (JSON.stringify(result) !== JSON.stringify(storedRaw.slice(0, RECENT_CWDS_LIMIT))) {
    await mkdir(HISTORY_DIR, { recursive: true });
    await writeFile(RECENT_CWDS_FILE, JSON.stringify(result, null, 2), "utf8");
  }

  return result;
}

async function saveHistoryEntry(
  input: Omit<HistoryEntry, "id" | "date" | "executedAt"> & {
    executedAt?: string;
  },
): Promise<HistoryEntry> {
  const executedAt = input.executedAt ?? new Date().toISOString();
  const date = formatDateFolder(new Date(executedAt));
  const id = randomUUID();
  const entry: HistoryEntry = {
    id,
    date,
    executedAt,
    command: input.command,
    cwd: input.cwd,
    stdout: truncateText(input.stdout ?? ""),
    stderr: truncateText(input.stderr ?? ""),
    exitCode: input.exitCode,
    durationMs: input.durationMs,
    error: input.error,
  };

  const dayDir = join(HISTORY_DIR, date);
  await mkdir(dayDir, { recursive: true });
  const filePath = join(dayDir, `${id}.json`);
  await writeFile(filePath, JSON.stringify(entry, null, 2), "utf8");
  await rememberCwd(entry.cwd);
  return entry;
}

async function readHistoryEntry(
  date: string,
  id: string,
): Promise<HistoryEntry | null> {
  if (!DATE_FOLDER_RE.test(date) || !HISTORY_ID_RE.test(id)) {
    return null;
  }

  try {
    const raw = await readFile(join(HISTORY_DIR, date, `${id}.json`), "utf8");
    return JSON.parse(raw) as HistoryEntry;
  } catch {
    return null;
  }
}

async function listHistory(query = ""): Promise<
  { date: string; entries: HistoryListItem[] }[]
> {
  const q = query.trim().toLowerCase();
  await mkdir(HISTORY_DIR, { recursive: true });

  let dateDirs: string[] = [];
  try {
    const entries = await readdir(HISTORY_DIR, { withFileTypes: true });
    dateDirs = entries
      .filter((entry) => entry.isDirectory() && DATE_FOLDER_RE.test(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => b.localeCompare(a));
  } catch {
    return [];
  }

  const groups: { date: string; entries: HistoryListItem[] }[] = [];

  for (const date of dateDirs) {
    const dayDir = join(HISTORY_DIR, date);
    let files: string[] = [];
    try {
      files = (await readdir(dayDir))
        .filter((name) => name.endsWith(".json"))
        .sort((a, b) => b.localeCompare(a));
    } catch {
      continue;
    }

    const items: HistoryListItem[] = [];
    for (const file of files) {
      const id = basename(file, ".json");
      if (!HISTORY_ID_RE.test(id)) {
        continue;
      }

      try {
        const raw = await readFile(join(dayDir, file), "utf8");
        const entry = JSON.parse(raw) as HistoryEntry;
        const listItem = toListItem(entry);
        if (q) {
          const haystack = [
            entry.command,
            entry.cwd,
            entry.stdout,
            entry.stderr,
            entry.error ?? "",
            entry.date,
          ]
            .join("\n")
            .toLowerCase();
          if (!haystack.includes(q)) {
            continue;
          }
        }
        items.push(listItem);
      } catch {
        // skip broken files
      }
    }

    items.sort((a, b) => b.executedAt.localeCompare(a.executedAt));
    if (items.length) {
      groups.push({ date, entries: items });
    }
  }

  return groups;
}

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

  if (candidate.tempDir !== undefined && typeof candidate.tempDir !== "string") {
    return null;
  }

  return {
    source: candidate.source,
    name: candidate.name,
    tempDir: candidate.tempDir,
  };
}

function validateRunCommandBody(body: unknown): RunCommandRequestBody | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return null;
  }

  const candidate = body as Record<string, unknown>;
  if (typeof candidate.command !== "string" || !candidate.command.trim()) {
    return null;
  }

  if (candidate.cwd !== undefined && typeof candidate.cwd !== "string") {
    return null;
  }

  return {
    command: candidate.command.trim(),
    cwd: candidate.cwd?.trim() || undefined,
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

function spawnDetached(
  command: string,
  args: string[],
  options: { shell?: boolean; cwd?: string } = {},
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      detached: true,
      env: getDetachedTerminalEnv(),
      stdio: "ignore",
      shell: options.shell ?? false,
      cwd: options.cwd,
    });

    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolvePromise();
    });
  });
}

async function openTerminalAtDirectory(directory: string): Promise<void> {
  const customCommand = process.env.LOCAL_CMD_RUNNER_TERMINAL?.trim();
  if (customCommand) {
    const rendered = customCommand.includes("{dir}")
      ? customCommand.replaceAll("{dir}", directory)
      : `${customCommand} ${JSON.stringify(directory)}`;

    if (IS_WINDOWS) {
      await spawnDetached(rendered, [], { shell: true });
    } else {
      await spawnDetached("sh", ["-c", rendered]);
    }
    return;
  }

  if (IS_WINDOWS) {
    try {
      await spawnDetached("wt.exe", ["-d", directory]);
      return;
    } catch {
      // ignore and try cmd
    }

    await spawnDetached(
      "cmd.exe",
      ["/c", "start", "", "cmd.exe", "/k", `cd /d ${directory}`],
    );
    return;
  }

  try {
    await spawnDetached("kitty", ["--detach", "--directory", directory]);
  } catch {
    await spawnDetached("x-terminal-emulator", ["--working-directory", directory]);
  }
}

async function openBrowser(url: string): Promise<void> {
  try {
    if (IS_WINDOWS) {
      await spawnDetached("cmd.exe", ["/c", "start", "", url]);
      return;
    }

    if (process.platform === "darwin") {
      await spawnDetached("open", [url]);
      return;
    }

    await spawnDetached("xdg-open", [url]);
  } catch (error) {
    console.error("failed to open browser:", error);
  }
}

async function runPuzzleTemp(args: string[]) {
  const command = process.env.LOCAL_CMD_RUNNER_PUZZLETEMP?.trim() || "puzzletemp";

  try {
    return await execFileAsync(command, args, {
      shell: IS_WINDOWS,
      windowsHide: true,
    });
  } catch (error) {
    if (!IS_WINDOWS || command !== "puzzletemp") {
      throw error;
    }

    for (const fallback of ["puzzletemp.cmd", "puzzletemp.exe"]) {
      try {
        return await execFileAsync(fallback, args, {
          shell: true,
          windowsHide: true,
        });
      } catch {
        // keep trying
      }
    }

    throw error;
  }
}

function runShellCommand(
  command: string,
  cwd: string,
): Promise<{ stdout: string; stderr: string; exitCode: number; durationMs: number }> {
  const startedAt = Date.now();

  return new Promise((resolvePromise, reject) => {
    const child = IS_WINDOWS
      ? spawn("cmd.exe", ["/d", "/s", "/c", command], {
          cwd,
          env: process.env,
          windowsHide: true,
        })
      : spawn("sh", ["-c", command], {
          cwd,
          env: process.env,
        });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill();
      reject(new Error(`Command timed out after ${COMMAND_TIMEOUT_MS}ms`));
    }, COMMAND_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.once("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(error);
    });

    child.once("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolvePromise({
        stdout,
        stderr,
        exitCode: code ?? 1,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

async function main() {
  try {
    await access(join(PUBLIC_DIR, "index.html"));
  } catch {
    console.error(`Web UI not found at ${PUBLIC_DIR}. Run npm run build first.`);
    process.exit(1);
  }

  app.use(express.static(PUBLIC_DIR));

  await mkdir(HISTORY_DIR, { recursive: true });

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      service: "local-cmd-runner",
      host: HOST,
      port: PORT,
      cwd: DEFAULT_CWD,
      tempDir: TEMP_DIR,
      historyDir: HISTORY_DIR,
    });
  });

  app.get("/api/history", async (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q : "";
    try {
      const groups = await listHistory(q);
      res.json({ historyDir: HISTORY_DIR, groups });
    } catch (error) {
      console.error("list history failed:", error);
      res.status(500).json({ error: "failed to list history" });
    }
  });

  app.get("/api/recent-cwds", async (_req, res) => {
    try {
      const cwds = await listRecentCwds();
      res.json({
        defaultCwd: DEFAULT_CWD,
        cwds,
      });
    } catch (error) {
      console.error("list recent cwds failed:", error);
      res.status(500).json({ error: "failed to list recent directories" });
    }
  });

  app.get("/api/history/:date/:id", async (req, res) => {
    const entry = await readHistoryEntry(req.params.date, req.params.id);
    if (!entry) {
      res.status(404).json({ error: "history entry not found" });
      return;
    }
    res.json(entry);
  });

  app.post("/api/run", async (req, res) => {
    const body = validateRunCommandBody(req.body);
    if (!body) {
      res.status(400).json({
        error: "Invalid request body. Expected { command: string, cwd?: string }.",
      });
      return;
    }

    const cwd = resolveConfiguredDirectory(body.cwd, DEFAULT_CWD);

    try {
      await access(cwd);
    } catch {
      res.status(400).json({ error: `Working directory does not exist: ${cwd}` });
      return;
    }

    console.log("running command:", body.command);
    console.log("cwd:", cwd);

    try {
      const result = await runShellCommand(body.command, cwd);
      const history = await saveHistoryEntry({
        command: body.command,
        cwd,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
      });
      const recentCwds = await listRecentCwds();
      res.json({
        command: body.command,
        cwd,
        ...result,
        history: toListItem(history),
        recentCwds,
      });
    } catch (error) {
      console.error("command failed:", error);
      const message = error instanceof Error ? error.message : "command failed";
      try {
        await saveHistoryEntry({
          command: body.command,
          cwd,
          stdout: "",
          stderr: "",
          exitCode: 1,
          durationMs: 0,
          error: message,
        });
      } catch (historyError) {
        console.error("save history failed:", historyError);
      }
      res.status(500).json({ error: message });
    }
  });

  app.post("/puzzletemp", async (req, res) => {
    const body = validatePuzzleTempBody(req.body);
    if (!body) {
      res.status(400).json({
        error:
          "Invalid request body. Expected { source: string, name?: string, tempDir?: string }.",
      });
      return;
    }

    const requestTempDir = resolveConfiguredDirectory(body.tempDir, TEMP_DIR);
    await mkdir(requestTempDir, { recursive: true });
    const filename = `${randomUUID()}.html`;
    const sourcePath = join(requestTempDir, filename);

    try {
      await writeFile(sourcePath, body.source, "utf8");

      const name = body.name ?? `noname-${Date.now()}`;
      const args = ["--name", name, "--cf-source", sourcePath];

      console.log("running command:", "puzzletemp", ...args);
      const { stdout, stderr } = await runPuzzleTemp(args);

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

      console.log("opening terminal at:", createdDirectory);
      await openTerminalAtDirectory(createdDirectory);

      res.sendStatus(200);
    } catch (error) {
      console.error("puzzletemp failed:", error);
      res.status(500).json({ error: "puzzletemp command failed" });
      await rm(sourcePath, { force: true });
    }
  });

  const server = createServer(app);

  server.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") {
      console.error(
        `端口 ${HOST}:${PORT} 已被占用。请先结束旧进程，或换端口启动：`,
      );
      console.error(`  netstat -ano | findstr :${PORT}`);
      console.error(
        `  PowerShell: Get-NetTCPConnection -LocalPort ${PORT} | Stop-Process -Id {$_.OwningProcess} -Force`,
      );
      console.error(`  或: $env:PORT=8152; npm start`);
      process.exit(1);
    }

    console.error("server error:", error);
    process.exit(1);
  });

  const shutdown = () => {
    server.close(() => process.exit(0));
    // Force exit if close hangs (open keep-alive connections, etc.).
    setTimeout(() => process.exit(0), 1500).unref();
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  server.listen(PORT, HOST, () => {
    const url = `http://${HOST}:${PORT}`;
    console.log(`app is listening on ${url}`);
    console.log(`default cwd: ${DEFAULT_CWD}`);
    console.log(`temp dir: ${TEMP_DIR}`);
    console.log(`history dir: ${HISTORY_DIR}`);
    if (OPEN_BROWSER) {
      void openBrowser(url);
    }
  });
}

main();
