import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp } from "../src/server/app.ts";
import { scriptedAssistant } from "../src/fixture.ts";
import { api, login } from "../src/client.ts";
import type { ModelClient } from "../src/model/types.ts";

export const tmpDb = () => join(mkdtempSync(join(tmpdir(), "remember-me-")), "test.sqlite");

export async function withApp<T>(fn: (ctx: { url: string; alice: string; bob: string; app: Awaited<ReturnType<typeof startApp>> }) => Promise<T>, model: () => ModelClient = scriptedAssistant): Promise<T> {
  const app = await startApp({ dbPath: tmpDb(), model });
  try {
    const alice = await login(app.url, "alice", "alice-test-pass");
    const bob = await login(app.url, "bob", "bob-test-pass");
    return await fn({ url: app.url, alice, bob, app });
  } finally {
    await app.close();
  }
}

export { api, login };
