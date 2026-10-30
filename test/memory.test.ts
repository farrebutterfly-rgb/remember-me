import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { openDb } from "../src/db.ts";
import { MemoryStore, MemoryValidationError } from "../src/memory.ts";
import { HistoryStore } from "../src/history.ts";
import { tmpDb } from "./helpers.ts";

const api = (ref: string) => ({ kind: "api" as const, ref });

test("every item carries owner, key, value, source and timestamps", () => {
  const m = new MemoryStore(openDb(":memory:"));
  const { item, action } = m.remember("usr_alice", "language", "FR ", api("req_1"));
  assert.equal(action, "created");
  assert.equal(item.owner, "usr_alice");
  assert.equal(item.key, "language");
  assert.equal(item.value, "fr");
  assert.deepEqual(item.source, { kind: "api", ref: "req_1" });
  assert.match(item.created_at, /^\d{4}-\d\d-\d\dT/);
  assert.equal(item.created_at, item.updated_at);
});

test("a correction replaces the active value and keeps the old one as superseded history", () => {
  const m = new MemoryStore(openDb(":memory:"));
  const a = m.remember("usr_alice", "language", "fr", api("req_1")).item;
  const b = m.remember("usr_alice", "language", "sv", api("req_2"));
  assert.equal(b.action, "corrected");
  assert.equal(b.item.id, a.id, "same item, new version");
  assert.equal(b.item.value, "sv");
  assert.equal(m.list("usr_alice").length, 1);
  const h = m.get("usr_alice", a.id)!.history;
  assert.deepEqual(h.map((v) => [v.seq, v.value, v.source.ref, v.superseded_at === null]), [
    [1, "fr", "req_1", false],
    [2, "sv", "req_2", true],
  ]);
});

test("delete removes the item from reads and erases every stored value, keeping a tombstone", () => {
  const m = new MemoryStore(openDb(":memory:"));
  const { item } = m.remember("usr_alice", "language", "fr", api("r1"));
  m.correct("usr_alice", item.id, "sv", api("r2"));
  assert.equal(m.forget("usr_alice", item.id, api("r3")), true);
  assert.equal(m.list("usr_alice").length, 0);
  assert.equal(m.get("usr_alice", item.id), undefined);
  assert.deepEqual(m.audit(item.id), { exists: true, deleted: true, values_left: 0 });
  assert.equal(m.forget("usr_alice", item.id, api("r4")), false, "second delete is a no-op");
  // The key can be saved again later as a fresh item.
  const again = m.remember("usr_alice", "language", "en", api("r5")).item;
  assert.notEqual(again.id, item.id);
});

test("the store itself is owner scoped: another owner gets nothing back and changes nothing", () => {
  const m = new MemoryStore(openDb(":memory:"));
  const { item } = m.remember("usr_alice", "language", "fr", api("r1"));
  assert.equal(m.get("usr_bob", item.id), undefined);
  assert.equal(m.correct("usr_bob", item.id, "sv", api("r2")), undefined);
  assert.equal(m.forget("usr_bob", item.id, api("r3")), false);
  assert.equal(m.get("usr_alice", item.id)!.value, "fr");
  assert.equal(m.get("usr_alice", item.id)!.history.length, 1);
});

test("known keys are validated, unknown keys must be snake_case short text", () => {
  const m = new MemoryStore(openDb(":memory:"));
  assert.throws(() => m.remember("usr_alice", "language", "klingon", api("r")), MemoryValidationError);
  assert.throws(() => m.remember("usr_alice", "report_format", "pdf", api("r")), MemoryValidationError);
  assert.throws(() => m.remember("usr_alice", "Bad Key", "x", api("r")), MemoryValidationError);
  assert.equal(m.remember("usr_alice", "timezone", "Europe/Stockholm", api("r")).item.value, "Europe/Stockholm");
});

test("memory survives closing and reopening the database file", () => {
  const path = tmpDb();
  const db1 = openDb(path);
  const id = new MemoryStore(db1).remember("usr_alice", "report_format", "table", api("r1")).item.id;
  db1.close();
  const db2 = openDb(path);
  assert.equal(new MemoryStore(db2).get("usr_alice", id)?.value, "table");
  db2.close();
});

test("history and memory live in separate tables", () => {
  const db = openDb(":memory:");
  const h = new HistoryStore(db);
  const c = h.create("usr_alice");
  h.append("usr_alice", c, "user", "my language is French");
  assert.equal(new MemoryStore(db).list("usr_alice").length, 0);
  assert.equal(h.messages("usr_bob", c), undefined);
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((t) => t.name);
  assert.deepEqual(tables, ["conversations", "memory_items", "memory_versions", "messages", "users"]);
  assert.ok(db instanceof DatabaseSync);
});
