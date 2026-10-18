export interface RunnerSpec {
  jobId: string;
  image?: string;
  payload?: unknown;
}
export interface ContainerRunner {
  run(spec: RunnerSpec, signal: AbortSignal): Promise<unknown>;
}
export class InProcessRunner implements ContainerRunner {
  constructor(
    private readonly handler: (
      spec: RunnerSpec,
      signal: AbortSignal,
    ) => Promise<unknown>,
  ) {}
  run(spec: RunnerSpec, signal: AbortSignal) {
    signal.throwIfAborted();
    return this.handler(spec, signal);
  }
}
export class DockerRunner {
  buildArgs(spec: RunnerSpec): string[] {
    if (
      !spec.image ||
      !/^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/.test(spec.image)
    )
      throw Error("Pinned image required");
    if (!/^[a-zA-Z0-9_-]+$/.test(spec.jobId)) throw Error("Invalid job id");
    return [
      "run",
      "--rm",
      "--network",
      "none",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--pids-limit",
      "256",
      "--memory",
      "2g",
      "--cpus",
      "2",
      "--user",
      "10001:10001",
      "--tmpfs",
      "/tmp:rw,size=256m,noexec",
      "--tmpfs",
      "/work:rw,size=1g",
      "-e",
      `AGENT_JOB_ID=${spec.jobId}`,
      "-i",
      spec.image,
      "agent-worker",
    ];
  }
}
