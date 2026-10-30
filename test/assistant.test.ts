import { test } from "node:test";
import assert from "node:assert/strict";
import { withApp, api } from "./helpers.ts";

const chat = (url: string, token: string, message: string, extra: Record<string, unknown> = {}) => api(url, "POST", "/chat", { token, body: { message, ...extra } });

test("saved preferences shape the reply, and the run log shows the memory read", async () => {
  await withApp(async ({ url, alice, app }) => {
    const s1 = await chat(url, alice, "/remember language: fr");
    const s2 = await chat(url, alice, "/remember report_format = table");
    assert.match(s1.body.reply, /^Saved: language = fr/);
    assert.match(s2.body.reply, /^Saved: report_format = table/);

    const r = await chat(url, alice, "orders report for 2026-W43");
    assert.equal(r.body.answer.language, "fr");
    assert.equal(r.body.answer.format, "table");
    assert.match(r.body.reply, /Commandes, semaine 2026-W43/);
    assert.match(r.body.reply, /\| Région \| Commandes \|/);
    // 41 + 97 + 88 + 85, computed by the tool from data/orders.json
    assert.match(r.body.reply, /\*\*311\*\*/);

    const run = app.runs.at(-1)!;
    const read = run.events.find((e) => e.type === "memory_read")!;
    assert.deepEqual((read.items as { key: string }[]).map((i) => i.key).sort(), ["language", "report_format"]);
    assert.deepEqual([...r.body.memory_read].sort(), [...r.body.answer.memory_ids_used].sort());
  });
});

test("with nothing saved the reply uses defaults and says so", async () => {
  await withApp(async ({ url, bob }) => {
    const r = await chat(url, bob, "orders report");
    assert.equal(r.body.answer.language, "en");
    assert.equal(r.body.answer.format, "bullets");
    assert.match(r.body.reply, /Orders, week 2026-W43/);
    assert.match(r.body.reply, /defaults, nothing saved/);
    assert.deepEqual(r.body.memory_read, []);
  });
});

test("a correction changes the next answer; a deletion stops affecting new answers", async () => {
  await withApp(async ({ url, alice }) => {
    const saved = await api(url, "POST", "/memories", { token: alice, body: { key: "language", value: "fr" } });
    const id = saved.body.item.id;
    assert.equal((await chat(url, alice, "orders report")).body.answer.language, "fr");

    const fix = await api(url, "PATCH", `/memories/${id}`, { token: alice, body: { value: "sv" } });
    assert.equal(fix.body.item.version, 2);
    const after = await chat(url, alice, "orders report");
    assert.equal(after.body.answer.language, "sv");
    assert.match(after.body.reply, /Ordrar, vecka 2026-W43/);

    assert.equal((await api(url, "DELETE", `/memories/${id}`, { token: alice })).status, 204);
    const gone = await chat(url, alice, "orders report");
    assert.equal(gone.body.answer.language, "en");
    assert.deepEqual(gone.body.memory_read, []);
    assert.equal((await api(url, "GET", `/memories/${id}`, { token: alice })).status, 404);
  });
});

test("/forget deletes by key through the chat command", async () => {
  await withApp(async ({ url, alice }) => {
    await chat(url, alice, "/remember report_format: table");
    const f = await chat(url, alice, "/forget report_format");
    assert.match(f.body.reply, /^Deleted: report_format/);
    assert.equal((await chat(url, alice, "orders report")).body.answer.format, "bullets");
    assert.equal((await chat(url, alice, "/forget report_format")).status, 404);
  });
});

test("an invalid value is refused and nothing is saved", async () => {
  await withApp(async ({ url, alice }) => {
    const r = await chat(url, alice, "/remember language: klingon");
    assert.equal(r.status, 400);
    assert.match(r.body.reply, /Not saved: invalid value for language/);
    assert.deepEqual((await api(url, "GET", "/memories", { token: alice })).body.items, []);
  });
});

test("history is kept per conversation and passed as context, but never becomes memory", async () => {
  await withApp(async ({ url, alice }) => {
    const first = await chat(url, alice, "hello, my language is French and I like tables");
    const conv = first.body.conversation_id;
    await chat(url, alice, "orders report", { conversation_id: conv });
    const msgs = (await api(url, "GET", `/conversations/${conv}/messages`, { token: alice })).body.messages;
    assert.deepEqual(msgs.map((m: { role: string }) => m.role), ["user", "assistant", "user", "assistant"]);
    assert.deepEqual((await api(url, "GET", "/memories", { token: alice })).body.items, []);
  });
});
