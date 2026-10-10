import { spawn } from "node:child_process";
import type { ResolvedCommand, CommandStreamEvent } from "./command";

// Each controlled request owns a new POSIX process group. Never signal a shared group.
export async function* controlledCommand(command: ResolvedCommand, input: string | undefined, signal: AbortSignal, cleanup?: (absent: boolean) => void): AsyncGenerator<CommandStreamEvent> {
  signal.throwIfAborted();
  const grouped = process.platform !== "win32";
  const child = spawn(command.executable, command.args, { env: { ...process.env, ...command.env }, cwd: command.cwd, stdio: "pipe", detached: grouped });
  let closed = false, stopping = false, overflow = false, code: number | null = null, failure: Error | undefined, bytes = 0;
  const queue: CommandStreamEvent[] = [];
  let wake: (() => void) | undefined, escalation: ReturnType<typeof setTimeout> | undefined;
  const notify = () => { wake?.(); wake = undefined; };
  const kill = (kind: NodeJS.Signals) => { try { if (grouped && child.pid) process.kill(-child.pid, kind); else child.kill(kind); } catch { /* absence is checked separately */ } };
  const absent = () => { if (!grouped) return closed; if (!child.pid) return closed; try { process.kill(-child.pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; } };
  const stop = () => { if (stopping) return; stopping = true; kill("SIGTERM"); escalation = setTimeout(() => kill("SIGKILL"), 1000); notify(); };
  const timer = setTimeout(stop, command.timeoutMs);
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) stop();
  child.on("error", error => { failure = error; closed = true; notify(); });
  child.on("close", value => { closed = true; code = value; notify(); });
  for (const stream of ["stdout", "stderr"] as const) child[stream].setEncoding("utf8").on("data", (chunk: string) => {
    bytes += Buffer.byteLength(chunk); if (bytes > 10 * 1024 * 1024) { overflow = true; stop(); return; }
    if (!stopping) queue.push({ stream, chunk }); notify();
  });
  child.stdin.on("error", () => {}); child.stdin.end(input);
  try {
    while (!closed || queue.length) {
      if (stopping) { queue.length = 0; break; }
      const next = queue.shift(); if (next) yield next;
      else await new Promise<void>(resolve => { wake = resolve; });
    }
  } finally {
    clearTimeout(timer); signal.removeEventListener("abort", stop);
    if (!closed || !absent()) stop();
    if (stopping) {
      const end = Date.now() + 2000;
      while ((!closed || !absent()) && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 10));
      if (!absent()) kill("SIGKILL");
      if (escalation) clearTimeout(escalation);
      cleanup?.(grouped && closed && absent());
      if (!closed) { child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy(); child.unref(); }
    }
  }
  if (signal.aborted || stopping || overflow) throw Object.assign(Error("Provider execution stopped; remote outcome is uncertain"), { uncertain: true });
  if (failure) throw failure;
  if (code !== 0) throw Error("Provider command failed");
}
