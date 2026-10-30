import { parseArgs } from "node:util";
import { startApp } from "../server/app.ts";
import { scriptedAssistant } from "../fixture.ts";
import { AnthropicModel } from "../model/anthropic.ts";
import type { ModelClient } from "../model/types.ts";

/**
 * Run the API as its own process. The demo and the restart test spawn this twice against the
 * same SQLite file to prove that memory survives a real process restart.
 * Prints one JSON line {"listening": url, "pid": n} on stdout when ready.
 */
const { values } = parseArgs({
  options: {
    db: { type: "string", default: ".data/remember-me.sqlite" },
    log: { type: "string" },
    port: { type: "string", default: "0" },
    model: { type: "string", default: "fixture" },
  },
});

let model: () => ModelClient;
if (values.model === "live") {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY is not set. --model live calls the real API and costs money; --model fixture does not.");
    process.exit(2);
  }
  model = () => new AnthropicModel();
} else {
  model = scriptedAssistant;
}

const app = await startApp({ dbPath: values.db!, logFile: values.log, port: Number(values.port), model });
console.log(JSON.stringify({ listening: app.url, pid: process.pid, db: values.db, model: values.model, auth: "test-only HMAC tokens, secret is random per process" }));

const stop = async () => {
  await app.close();
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
