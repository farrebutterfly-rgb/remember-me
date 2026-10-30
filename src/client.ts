import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

/** Minimal JSON client for the API. Used by the demo and the tests. */
export async function api(base: string, method: string, path: string, opts: { token?: string; body?: unknown } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : undefined) as any };
}

export async function login(base: string, username: string, password: string): Promise<string> {
  const r = await api(base, "POST", "/login", { body: { username, password } });
  if (r.status !== 200) throw new Error(`login failed for ${username}: ${r.status}`);
  return r.body.token as string;
}

export interface Spawned {
  url: string;
  pid: number;
  stop(): Promise<number | null>;
}

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Start `src/cli/serve.ts` as a separate OS process and wait for its ready line. */
export async function spawnServer(args: { db: string; log?: string }): Promise<Spawned> {
  const argv = ["--disable-warning=ExperimentalWarning", "--import", "tsx", "src/cli/serve.ts", "--db", args.db, ...(args.log ? ["--log", args.log] : [])];
  const child: ChildProcess = spawn(process.execPath, argv, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env } });
  let stderr = "";
  child.stderr!.on("data", (d) => (stderr += d));
  const ready = await new Promise<{ listening: string; pid: number }>((resolve, reject) => {
    const rl = createInterface({ input: child.stdout! });
    const timer = setTimeout(() => reject(new Error(`server did not start in 15 s. stderr: ${stderr}`)), 15000);
    rl.once("line", (l) => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(l));
      } catch {
        reject(new Error(`unexpected first line: ${l}`));
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited early with ${code}. stderr: ${stderr}`));
    });
  });
  return {
    url: ready.listening,
    pid: ready.pid,
    stop: () =>
      new Promise((resolve) => {
        if (child.exitCode !== null) return resolve(child.exitCode);
        child.once("exit", (code) => resolve(code));
        child.kill("SIGTERM");
      }),
  };
}
