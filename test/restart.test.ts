import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnServer, api, login } from "../src/client.ts";
import { tmpDb } from "./helpers.ts";
import { readFileSync } from "node:fs";

test("a preference saved in one process is used by a new process on the same database file", async () => {
  const db = tmpDb();
  const log = db.replace(/test\.sqlite$/, "run.jsonl");
  const p1 = await spawnServer({ db, log });
  const t1 = await login(p1.url, "alice", "alice-test-pass");
  const saved = await api(p1.url, "POST", "/chat", { token: t1, body: { message: "/remember language: fr" } });
  assert.match(saved.body.reply, /^Saved/);
  assert.equal(await p1.stop(), 0);

  const p2 = await spawnServer({ db, log });
  try {
    assert.notEqual(p2.pid, p1.pid);
    // The old token dies with the old process: the signing secret is random per process.
    assert.equal((await api(p2.url, "GET", "/memories", { token: t1 })).status, 401);
    const t2 = await login(p2.url, "alice", "alice-test-pass");
    const r = await api(p2.url, "POST", "/chat", { token: t2, body: { message: "orders report" } });
    assert.equal(r.body.answer.language, "fr");
    assert.match(r.body.reply, /Commandes, semaine/);
  } finally {
    await p2.stop();
  }
  // The second process's run log records the read from storage.
  const reads = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.type === "memory_read" && e.items?.[0]?.key === "language");
  assert.equal(reads.length, 1);
  assert.equal(reads[0].items[0].value, "fr");
});
