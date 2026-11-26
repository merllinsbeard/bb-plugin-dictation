import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

// bb may run without the login shell's PATH, so the usual install locations
// are searched after PATH.
export async function findExecutable(name: string): Promise<string | undefined> {
  const home = homedir();
  const directories = [
    ...(process.env.PATH ?? "").split(delimiter).filter((dir) => isAbsolute(dir)),
    join(home, ".local", "bin"),
    join(home, ".cargo", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
  ];
  for (const directory of directories) {
    const candidate = join(directory, name);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  return undefined;
}

export type ProcessResult = { code: number | null; stdout: string; stderr: string };

// Launchers such as uv and agy-pool start the real worker as their own child,
// so the command runs in a process group of its own and cancellation kills the
// whole group.
export function runProcessGroup(
  command: string,
  args: string[],
  options: { signal: AbortSignal; env?: NodeJS.ProcessEnv; cwd?: string },
): Promise<ProcessResult> {
  const { signal } = options;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: options.env ?? process.env,
      cwd: options.cwd,
    });
    let stdout = "";
    let stderr = "";
    const kill = () => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {}
    };
    signal.addEventListener("abort", kill, { once: true });
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-4000);
    });
    child.on("error", (error) => {
      signal.removeEventListener("abort", kill);
      reject(error);
    });
    child.on("close", (code) => {
      signal.removeEventListener("abort", kill);
      resolve({ code, stdout, stderr });
    });
  });
}

export function lastLine(text: string, max = 300): string {
  return (text.trim().split("\n").at(-1) ?? "").slice(0, max);
}
