import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { hashPassword } from "./auth.ts";

/**
 * One SQLite file holds everything. Three separate concerns, three sets of tables:
 *   users                         test accounts (seeded)
 *   conversations, messages       conversation history: what was said, append-only
 *   memory_items, memory_versions persistent memory: what the user explicitly chose to keep
 * History is never read back as memory, and memory is never written from history.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,
  username   TEXT NOT NULL UNIQUE,
  pw_salt    TEXT NOT NULL,
  pw_hash    TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id         TEXT PRIMARY KEY,
  owner      TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  owner           TEXT NOT NULL REFERENCES users(id),
  role            TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'document')),
  name            TEXT,
  text            TEXT NOT NULL,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_by_conversation ON messages(conversation_id, created_at);

CREATE TABLE IF NOT EXISTS memory_items (
  id                TEXT PRIMARY KEY,
  owner             TEXT NOT NULL REFERENCES users(id),
  key               TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  deleted_at        TEXT,
  delete_source     TEXT
);
-- At most one live item per (owner, key). Deleted items keep a tombstone row.
CREATE UNIQUE INDEX IF NOT EXISTS one_live_item_per_key ON memory_items(owner, key) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS memory_versions (
  id            TEXT PRIMARY KEY,
  item_id       TEXT NOT NULL REFERENCES memory_items(id),
  seq           INTEGER NOT NULL,
  value         TEXT,              -- NULL once the item is deleted (value erased)
  source_kind   TEXT NOT NULL,     -- chat_command | api
  source_ref    TEXT NOT NULL,     -- message id or request id that created this version
  created_at    TEXT NOT NULL,
  superseded_at TEXT,              -- NULL means this is the active version
  UNIQUE (item_id, seq)
);
`;

export interface SeedUser {
  id: string;
  username: string;
  password: string;
}

export function loadSeedUsers(file = new URL("../data/users.json", import.meta.url)): SeedUser[] {
  return (JSON.parse(readFileSync(file, "utf8")) as { users: SeedUser[] }).users;
}

export function openDb(path: string, seed: SeedUser[] = loadSeedUsers()): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 2000;");
  db.exec(SCHEMA);
  const insert = db.prepare("INSERT OR IGNORE INTO users (id, username, pw_salt, pw_hash, created_at) VALUES (?, ?, ?, ?, ?)");
  for (const u of seed) {
    const { salt, hash } = hashPassword(u.password);
    insert.run(u.id, u.username, salt, hash, new Date().toISOString());
  }
  return db;
}
