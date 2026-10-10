import { controlledCommand } from "./controlled-command";
import { spawn } from "node:child_process";
import type { CommandSpec } from "../types";
import { applyTemplate, applyTemplateRecord, checkShellSafety, type TemplateOptions } from "./template.js";

export interface ResolvedCommand {
  executable: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
  timeoutMs: number;
}

export interface CommandOutput {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
}

export interface CommandStreamEvent {
  stream: "stdout" | "stderr";
  chunk: string;
}

export interface ResolveCommandOptions extends TemplateOptions {
  /** Optional logger for shell safety warnings */
  logger?: {
    warn: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

export function resolveCommand(
  spec: CommandSpec,
  vars: Record<string, string>,
  options: ResolveCommandOptions = {},
): ResolvedCommand {
  const { logger, ...templateOptions } = options;

  // Check for shell safety issues and log warnings
  if (logger) {
    const warnings = checkShellSafety(vars);
    for (const warning of warnings) {
      logger.warn(warning.warning, {
        variable: warning.key,
        valuePreview: warning.value,
      });
    }
  }

  return {
    executable: applyTemplate(spec.executable, vars, templateOptions),
    args: spec.args.map((arg) => applyTemplate(arg, vars, templateOptions)),
    env: applyTemplateRecord(spec.env, vars, templateOptions),
    cwd: spec.cwd ? applyTemplate(spec.cwd, vars, templateOptions) : undefined,
    timeoutMs: spec.timeoutMs,
  };
}

export async function runCommand(
  command: ResolvedCommand,
  stdinData?: string,
  signal?: AbortSignal,
  cleanup?: (absent: boolean) => void,
): Promise<CommandOutput> {
  if (signal) {
    let stdout = "", stderr = "";
    for await (const event of controlledCommand(command, stdinData, signal, cleanup)) { if (event.stream === "stdout") stdout += event.chunk; else stderr += event.chunk; }
    return { stdout, stderr, exitCode: 0, signal: null, timedOut: false };
  }
  const MAX_OUTPUT_BYTES = 10 * 1024 * 1024; // 10MB cap per stream

  return await new Promise<CommandOutput>((resolve, reject) => {
    const child = spawn(command.executable, command.args, {
      env: {
        ...process.env,
        ...command.env,
      },
      cwd: command.cwd,
      stdio: "pipe",
    });

    let stdout = "";
    let stderr = "";
    let finished = false;
    let timedOut = false;
    let sigkillTimer: ReturnType<typeof setTimeout> | undefined;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      sigkillTimer = setTimeout(() => child.kill("SIGKILL"), 2000);
    }, command.timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => {
      if (stdout.length < MAX_OUTPUT_BYTES) {
        stdout += chunk;
      }
    });

    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < MAX_OUTPUT_BYTES) {
        stderr += chunk;
      }
    });

    child.on("error", (err) => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timer);
      if (sigkillTimer) clearTimeout(sigkillTimer);
      reject(err);
    });

    child.on("close", (exitCode, signal) => {
      if (finished) {
        return;
      }

      finished = true;
      clearTimeout(timer);
      if (sigkillTimer) clearTimeout(sigkillTimer);
      resolve({
        stdout,
        stderr,
        exitCode,
        signal,
        timedOut,
      });
    });

    // Ignore EPIPE errors when child process exits before reading all of stdin
    child.stdin.on("error", () => { /* ignore EPIPE */ });

    if (stdinData !== undefined) {
      child.stdin.write(stdinData);
    }
    child.stdin.end();
  });
}

export async function* runCommandStream(
  command: ResolvedCommand,
  stdinData?: string,
  requestSignal?: AbortSignal,
  cleanup?: (absent: boolean) => void,
): AsyncGenerator<CommandStreamEvent, void, void> {
  if (requestSignal) { yield* controlledCommand(command, stdinData, requestSignal, cleanup); return; }
  const MAX_OUTPUT_BYTES = 10 * 1024 * 1024; // 10MB cap per stream
  const child = spawn(command.executable, command.args, {
    env: {
      ...process.env,
      ...command.env,
    },
    cwd: command.cwd,
    stdio: "pipe",
  });

  const queue: CommandStreamEvent[] = [];
  let stdout = "";
  let stderr = "";
  let finished = false;
  let timedOut = false;
  let exitCode: number | null = null;
  let signal: NodeJS.Signals | null = null;
  let streamError: Error | null = null;
  let wake: (() => void) | undefined;
  let sigkillTimer: ReturnType<typeof setTimeout> | undefined;

  const notify = () => {
    const resolver = wake;
    wake = undefined;
    resolver?.();
  };

  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    sigkillTimer = setTimeout(() => child.kill("SIGKILL"), 2000);
  }, command.timeoutMs);

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  child.stdout.on("data", (chunk: string) => {
    if (stdout.length < MAX_OUTPUT_BYTES) {
      stdout += chunk;
    }
    queue.push({
      stream: "stdout",
      chunk,
    });
    notify();
  });

  child.stderr.on("data", (chunk: string) => {
    if (stderr.length < MAX_OUTPUT_BYTES) {
      stderr += chunk;
    }
    queue.push({
      stream: "stderr",
      chunk,
    });
    notify();
  });

  child.on("error", (err) => {
    if (finished) {
      return;
    }
    streamError = err;
    finished = true;
    clearTimeout(timer);
    if (sigkillTimer) {
      clearTimeout(sigkillTimer);
    }
    notify();
  });

  child.on("close", (closeExitCode, closeSignal) => {
    if (finished) {
      return;
    }

    finished = true;
    exitCode = closeExitCode;
    signal = closeSignal;
    clearTimeout(timer);
    if (sigkillTimer) {
      clearTimeout(sigkillTimer);
    }
    notify();
  });

  child.stdin.on("error", () => { /* ignore EPIPE */ });

  if (stdinData !== undefined) {
    child.stdin.write(stdinData);
  }
  child.stdin.end();

  try {
    while (!finished || queue.length > 0) {
      if (queue.length === 0) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        continue;
      }

      const next = queue.shift();
      if (next) {
        yield next;
      }
    }
  } finally {
    if (!finished) {
      child.kill("SIGTERM");
    }
  }

  if (streamError) {
    throw streamError;
  }

  if (timedOut) {
    throw new Error(`Provider command timed out after ${command.timeoutMs}ms.`);
  }

  if (exitCode !== 0) {
    throw new Error(
      [
        `Provider command exited with code ${exitCode}.`,
        stderr ? `stderr: ${stderr.trim()}` : "",
        stdout ? `stdout: ${stdout.trim()}` : "",
        signal ? `signal: ${signal}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
}
