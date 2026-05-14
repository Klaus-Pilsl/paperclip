import { existsSync, readFileSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import { ensurePostgresDatabase, getPostgresDataDirectory } from "./client.js";
import { createEmbeddedPostgresLogBuffer, formatEmbeddedPostgresError } from "./embedded-postgres-error.js";
import { resolveDatabaseTarget } from "./runtime-config.js";

type EmbeddedPostgresInstance = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};

type EmbeddedPostgresCtor = new (opts: {
  databaseDir: string;
  user: string;
  password: string;
  port: number;
  persistent: boolean;
  initdbFlags?: string[];
  onLog?: (message: unknown) => void;
  onError?: (message: unknown) => void;
}) => EmbeddedPostgresInstance;

export type MigrationConnection = {
  connectionString: string;
  source: string;
  stop: () => Promise<void>;
};

function readRunningPostmasterPid(postmasterPidFile: string): number | null {
  if (!existsSync(postmasterPidFile)) return null;
  try {
    const pid = Number(readFileSync(postmasterPidFile, "utf8").split("\n")[0]?.trim());
    if (!Number.isInteger(pid) || pid <= 0) return null;
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

function readPidFilePort(postmasterPidFile: string): number | null {
  if (!existsSync(postmasterPidFile)) return null;
  try {
    const lines = readFileSync(postmasterPidFile, "utf8").split("\n");
    const port = Number(lines[3]?.trim());
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

async function isPortInUse(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once("error", (error: NodeJS.ErrnoException) => {
      resolve(error.code === "EADDRINUSE");
    });
    server.listen(port, "127.0.0.1", () => {
      server.close();
      resolve(false);
    });
  });
}

async function findAvailablePort(startPort: number): Promise<number> {
  const maxLookahead = 20;
  let port = startPort;
  for (let i = 0; i < maxLookahead; i += 1, port += 1) {
    if (!(await isPortInUse(port))) return port;
  }
  throw new Error(
    `Embedded PostgreSQL could not find a free port from ${startPort} to ${startPort + maxLookahead - 1}`,
  );
}

// On Windows, a hard shutdown (terminal close / Ctrl+C race) can orphan postgres
// worker processes (bg writer, checkpointer, autovacuum, …) that hold the named
// shared-memory segment even after the main postmaster exits. This prevents a
// fresh postgres from starting ("pre-existing shared memory block is still in
// use"). Kill all postgres.exe processes by image name and wait for Windows to
// release the kernel objects before retrying.
async function killOrphanedPostgresOnWindows(): Promise<void> {
  await new Promise<void>((res) => {
    const tk = spawn("taskkill", ["/im", "postgres.exe", "/f"], { stdio: "ignore" });
    tk.on("close", () => res());
    tk.on("error", () => res());
  });
  await new Promise((res) => setTimeout(res, 1500));
}

function hasSharedMemoryConflict(logs: string[]): boolean {
  return logs.some((line) =>
    line.toLowerCase().includes("shared memory block is still in use"),
  );
}

async function loadEmbeddedPostgresCtor(): Promise<EmbeddedPostgresCtor> {
  try {
    const mod = await import("embedded-postgres");
    return mod.default as EmbeddedPostgresCtor;
  } catch {
    throw new Error(
      "Embedded PostgreSQL support requires dependency `embedded-postgres`. Reinstall dependencies and try again.",
    );
  }
}

async function ensureEmbeddedPostgresConnection(
  dataDir: string,
  preferredPort: number,
): Promise<MigrationConnection> {
  const EmbeddedPostgres = await loadEmbeddedPostgresCtor();
  const selectedPort = await findAvailablePort(preferredPort);
  const postmasterPidFile = path.resolve(dataDir, "postmaster.pid");
  const pgVersionFile = path.resolve(dataDir, "PG_VERSION");
  const runningPid = readRunningPostmasterPid(postmasterPidFile);
  const runningPort = readPidFilePort(postmasterPidFile);
  const preferredAdminConnectionString = `postgres://paperclip:paperclip@127.0.0.1:${preferredPort}/postgres`;
  const logBuffer = createEmbeddedPostgresLogBuffer();

  if (!runningPid && existsSync(pgVersionFile)) {
    try {
      const actualDataDir = await getPostgresDataDirectory(preferredAdminConnectionString);
      const matchesDataDir =
        typeof actualDataDir === "string" &&
        path.resolve(actualDataDir) === path.resolve(dataDir);
      if (!matchesDataDir) {
        throw new Error("reachable postgres does not use the expected embedded data directory");
      }
      await ensurePostgresDatabase(preferredAdminConnectionString, "paperclip");
      process.emitWarning(
        `Adopting an existing PostgreSQL instance on port ${preferredPort} for embedded data dir ${dataDir} because postmaster.pid is missing.`,
      );
      return {
        connectionString: `postgres://paperclip:paperclip@127.0.0.1:${preferredPort}/paperclip`,
        source: `embedded-postgres@${preferredPort}`,
        stop: async () => {},
      };
    } catch {
      // Fall through and attempt to start the configured embedded cluster.
    }
  }

  if (runningPid) {
    const port = runningPort ?? preferredPort;
    const adminConnectionString = `postgres://paperclip:paperclip@127.0.0.1:${port}/postgres`;
    await ensurePostgresDatabase(adminConnectionString, "paperclip");
    return {
      connectionString: `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`,
      source: `embedded-postgres@${port}`,
      stop: async () => {},
    };
  }

  const instance = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "paperclip",
    password: "paperclip",
    port: selectedPort,
    persistent: true,
    initdbFlags: ["--encoding=UTF8", "--locale=C", "--lc-messages=C"],
    onLog: logBuffer.append,
    onError: logBuffer.append,
  });

  if (!existsSync(path.resolve(dataDir, "PG_VERSION"))) {
    try {
      await instance.initialise();
    } catch (error) {
      throw formatEmbeddedPostgresError(error, {
        fallbackMessage:
          `Failed to initialize embedded PostgreSQL cluster in ${dataDir} on port ${selectedPort}`,
        recentLogs: logBuffer.getRecentLogs(),
      });
    }
  }
  if (existsSync(postmasterPidFile)) {
    let stalePid: number | undefined;
    try {
      const parsed = Number(readFileSync(postmasterPidFile, "utf8").split("\n")[0]?.trim());
      if (Number.isInteger(parsed) && parsed > 0) stalePid = parsed;
    } catch { /* ignore */ }

    if (stalePid !== undefined) {
      await new Promise<void>((res) => {
        if (process.platform === "win32") {
          const tk = spawn("taskkill", ["/pid", String(stalePid), "/f", "/t"]);
          tk.on("close", () => res());
        } else {
          try { process.kill(stalePid as number, "SIGTERM"); } catch { /* ignore */ }
          res();
        }
      });
      await new Promise((res) => setTimeout(res, 600));
    }

    rmSync(postmasterPidFile, { force: true });
  }
  try {
    await instance.start();
  } catch (error) {
    const recentLogs = logBuffer.getRecentLogs();
    if (process.platform === "win32" && hasSharedMemoryConflict(recentLogs)) {
      await killOrphanedPostgresOnWindows();
      try {
        await instance.start();
      } catch (retryError) {
        throw formatEmbeddedPostgresError(retryError, {
          fallbackMessage: `Failed to start embedded PostgreSQL on port ${selectedPort}`,
          recentLogs: logBuffer.getRecentLogs(),
        });
      }
    } else {
      throw formatEmbeddedPostgresError(error, {
        fallbackMessage: `Failed to start embedded PostgreSQL on port ${selectedPort}`,
        recentLogs,
      });
    }
  }

  const adminConnectionString = `postgres://paperclip:paperclip@127.0.0.1:${selectedPort}/postgres`;
  await ensurePostgresDatabase(adminConnectionString, "paperclip");

  return {
    connectionString: `postgres://paperclip:paperclip@127.0.0.1:${selectedPort}/paperclip`,
    source: `embedded-postgres@${selectedPort}`,
    stop: async () => {
      await instance.stop();
    },
  };
}

export async function resolveMigrationConnection(): Promise<MigrationConnection> {
  const target = resolveDatabaseTarget();
  if (target.mode === "postgres") {
    return {
      connectionString: target.connectionString,
      source: target.source,
      stop: async () => {},
    };
  }

  return ensureEmbeddedPostgresConnection(target.dataDir, target.port);
}
