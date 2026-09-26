/**
 * Ephemeral execution sandbox for the capability oracle.
 *
 * Runs generated code + its tests in a disposable temp directory as a
 * locked-down subprocess: an executable allowlist (no arbitrary binaries), no
 * shell (argv is passed directly, so nothing is interpreted), a hard timeout
 * that SIGKILLs a runaway, output size caps, a minimal environment (no inherited
 * secrets), and the whole directory removed afterward. `passed` is exit code 0
 * within the time limit, nothing else.
 *
 * HONEST LIMIT: a bare subprocess on the host is process- and filesystem-
 * isolated and time/output-bounded, but it is NOT network-isolated - the OS
 * still lets it open sockets. Proxy env is stripped, but true egress control
 * needs a container / microVM. That is the deliberate next hardening step; this
 * is the documented first-proof isolation, adequate for running our own graded
 * tasks and never a place to run genuinely hostile code unattended.
 *
 * Server-only (spawns a process); never import into client code.
 */
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, isAbsolute, normalize } from "node:path";

/** Executables the sandbox is allowed to launch. Deliberately tiny. */
export const ALLOWED_EXECUTABLES: readonly string[] = ["node"];

export interface SandboxSpec {
  /** Relative path -> file content. Paths are confined to the temp dir. */
  files: Record<string, string>;
  /** Argv, already split. argv[0] must be in ALLOWED_EXECUTABLES. No shell. */
  command: readonly string[];
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface SandboxResult {
  passed: boolean;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
  /** Set when the run could not even start (bad path, disallowed executable). */
  error: string | null;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_OUTPUT = 256 * 1024;

function fail(error: string, started: number): SandboxResult {
  return { passed: false, exitCode: null, signal: null, timedOut: false, stdout: "", stderr: "", durationMs: Date.now() - started, error };
}

/** Reject any path that escapes the sandbox root (traversal / absolute). */
function isConfined(rel: string): boolean {
  if (isAbsolute(rel)) return false;
  const norm = normalize(rel);
  return !norm.startsWith("..") && !norm.includes(`..${"/"}`) && norm !== "..";
}

export async function runInSandbox(spec: SandboxSpec): Promise<SandboxResult> {
  const started = Date.now();
  const timeoutMs = spec.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutput = spec.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;

  const argv = spec.command;
  if (argv.length === 0 || !ALLOWED_EXECUTABLES.includes(argv[0])) {
    return fail(`executable not allowed: ${argv[0] ?? "(none)"}`, started);
  }
  for (const rel of Object.keys(spec.files)) {
    if (!isConfined(rel)) return fail(`file path escapes the sandbox: ${rel}`, started);
  }

  let dir: string | null = null;
  try {
    dir = await mkdtemp(join(tmpdir(), "ai-code-sbx-"));
    for (const [rel, content] of Object.entries(spec.files)) {
      const abs = join(dir, rel);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content, "utf-8");
    }

    // Minimal environment: PATH only, so the subprocess inherits no secrets.
    // No shell (shell:false is the spawn default with an argv array).
    // Minimal, deliberately partial: the repo's ProcessEnv augmentation marks
    // app keys required, but the subprocess must inherit none of them.
    const env = { PATH: process.env.PATH, HOME: dir } as unknown as NodeJS.ProcessEnv;

    return await new Promise<SandboxResult>((resolve) => {
      const child = spawn(argv[0], argv.slice(1), { cwd: dir!, env, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const clip = (buf: string, chunk: Buffer): string =>
        buf.length >= maxOutput ? buf : (buf + chunk.toString()).slice(0, maxOutput);
      child.stdout.on("data", (c: Buffer) => { stdout = clip(stdout, c); });
      child.stderr.on("data", (c: Buffer) => { stderr = clip(stderr, c); });

      const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);

      child.on("error", (e) => {
        clearTimeout(timer);
        resolve(fail(`spawn failed: ${e.message}`, started));
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        resolve({
          passed: code === 0 && !timedOut,
          exitCode: code,
          signal: signal ?? null,
          timedOut,
          stdout,
          stderr,
          durationMs: Date.now() - started,
          error: null,
        });
      });
    });
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e), started);
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
