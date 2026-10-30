import type { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { z } from "zod";

/**
 * Persistent, user-scoped memory. Every public method takes the owner as its first argument and
 * every query filters on it, so there is no code path that reads or changes an item without
 * naming whose it is. The HTTP layer passes the owner from the verified token, never from input.
 */

export const LANGUAGES = ["en", "sv", "fr"] as const;
export const REPORT_FORMATS = ["bullets", "table"] as const;
export type Language = (typeof LANGUAGES)[number];
export type ReportFormat = (typeof REPORT_FORMATS)[number];

/** Known keys get a strict value schema. Other keys are allowed as short free text. */
const KNOWN: Record<string, z.ZodType<string>> = {
  language: z.enum(LANGUAGES),
  report_format: z.enum(REPORT_FORMATS),
};
export const MemoryKey = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/, "key must be lower_snake_case, 1 to 32 characters");
const FreeValue = z.string().trim().min(1).max(200);

export function validateEntry(key: string, value: string): { ok: true; key: string; value: string } | { ok: false; message: string } {
  const k = MemoryKey.safeParse(key);
  if (!k.success) return { ok: false, message: k.error.issues[0]?.message ?? "invalid key" };
  const known = KNOWN[k.data];
  // Known keys are enums, so normalise case and whitespace before checking.
  const v = known ? known.safeParse(String(value).trim().toLowerCase()) : FreeValue.safeParse(value);
  if (!v.success) {
    const allowed = known instanceof z.ZodEnum ? ` (allowed: ${known.options.join(", ")})` : "";
    return { ok: false, message: `invalid value for ${k.data}${allowed}` };
  }
  return { ok: true, key: k.data, value: v.data };
}

export interface Source {
  /** chat_command: the user typed /remember or /forget. api: the user called the memory API. */
  kind: "chat_command" | "api";
  /** The message id or request id that caused the change. */
  ref: string;
}

export interface MemoryItem {
  id: string;
  owner: string;
  key: string;
  value: string;
  version: number;
  source: Source;
  created_at: string;
  updated_at: string;
}

export interface MemoryVersion {
  id: string;
  seq: number;
  value: string | null;
  source: Source;
  created_at: string;
  superseded_at: string | null;
}

export class MemoryValidationError extends Error {}

const newId = (p: string) => `${p}_${randomBytes(6).toString("hex")}`;

type Row = Record<string, string | number | null>;

export class MemoryStore {
  constructor(private readonly db: DatabaseSync, private readonly clock = () => new Date().toISOString()) {}

  private toItem(r: Row): MemoryItem {
    return {
      id: r.id as string,
      owner: r.owner as string,
      key: r.key as string,
      value: r.value as string,
      version: r.seq as number,
      source: { kind: r.source_kind as Source["kind"], ref: r.source_ref as string },
      created_at: r.created_at as string,
      updated_at: r.updated_at as string,
    };
  }

  private static readonly LIVE = `
    SELECT i.id, i.owner, i.key, i.created_at, i.updated_at, v.value, v.seq, v.source_kind, v.source_ref
    FROM memory_items i JOIN memory_versions v ON v.item_id = i.id AND v.superseded_at IS NULL
    WHERE i.owner = ? AND i.deleted_at IS NULL`;

  /** Active items for one owner. */
  list(owner: string): MemoryItem[] {
    return (this.db.prepare(`${MemoryStore.LIVE} ORDER BY i.key`).all(owner) as Row[]).map((r) => this.toItem(r));
  }

  /** One live item with its full version history, or undefined if it does not exist for this owner. */
  get(owner: string, id: string): (MemoryItem & { history: MemoryVersion[] }) | undefined {
    const r = this.db.prepare(`${MemoryStore.LIVE} AND i.id = ?`).get(owner, id) as Row | undefined;
    if (!r) return undefined;
    const history = (this.db.prepare("SELECT id, seq, value, source_kind, source_ref, created_at, superseded_at FROM memory_versions WHERE item_id = ? ORDER BY seq").all(id) as Row[]).map((h) => ({
      id: h.id as string,
      seq: h.seq as number,
      value: h.value as string | null,
      source: { kind: h.source_kind as Source["kind"], ref: h.source_ref as string },
      created_at: h.created_at as string,
      superseded_at: h.superseded_at as string | null,
    }));
    return { ...this.toItem(r), history };
  }

  getByKey(owner: string, key: string): MemoryItem | undefined {
    const r = this.db.prepare(`${MemoryStore.LIVE} AND i.key = ?`).get(owner, key) as Row | undefined;
    return r ? this.toItem(r) : undefined;
  }

  /**
   * Save a value under a key. If the key already has a live item this is a correction: a new
   * version becomes active and the old one is kept, marked superseded.
   */
  remember(owner: string, key: string, value: string, source: Source): { item: MemoryItem; action: "created" | "corrected" | "unchanged" } {
    const v = validateEntry(key, value);
    if (!v.ok) throw new MemoryValidationError(v.message);
    const existing = this.getByKey(owner, v.key);
    if (existing) {
      if (existing.value === v.value) return { item: existing, action: "unchanged" };
      return { item: this.writeVersion(owner, existing.id, v.value, source)!, action: "corrected" };
    }
    const now = this.clock();
    const id = newId("mem");
    this.tx(() => {
      this.db.prepare("INSERT INTO memory_items (id, owner, key, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(id, owner, v.key, now, now);
      this.db.prepare("INSERT INTO memory_versions (id, item_id, seq, value, source_kind, source_ref, created_at) VALUES (?, ?, 1, ?, ?, ?, ?)").run(newId("ver"), id, v.value, source.kind, source.ref, now);
    });
    return { item: this.getByKey(owner, v.key)!, action: "created" };
  }

  /** Correct an item by id. Returns undefined when the owner has no such live item. */
  correct(owner: string, id: string, value: string, source: Source): MemoryItem | undefined {
    const cur = this.get(owner, id);
    if (!cur) return undefined;
    const v = validateEntry(cur.key, value);
    if (!v.ok) throw new MemoryValidationError(v.message);
    if (v.value === cur.value) return cur;
    return this.writeVersion(owner, id, v.value, source);
  }

  private writeVersion(owner: string, id: string, value: string, source: Source): MemoryItem | undefined {
    const now = this.clock();
    this.tx(() => {
      const top = this.db.prepare("SELECT MAX(seq) AS s FROM memory_versions WHERE item_id = ?").get(id) as { s: number };
      this.db.prepare("UPDATE memory_versions SET superseded_at = ? WHERE item_id = ? AND superseded_at IS NULL").run(now, id);
      this.db.prepare("INSERT INTO memory_versions (id, item_id, seq, value, source_kind, source_ref, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(newId("ver"), id, top.s + 1, value, source.kind, source.ref, now);
      this.db.prepare("UPDATE memory_items SET updated_at = ? WHERE id = ? AND owner = ?").run(now, id, owner);
    });
    return this.get(owner, id);
  }

  /**
   * Delete an item. The tombstone (key, timestamps, sources) stays for audit; every stored value,
   * including superseded ones, is erased. Returns false when the owner has no such live item.
   */
  forget(owner: string, id: string, source: Source): boolean {
    const now = this.clock();
    let changed = 0;
    this.tx(() => {
      const r = this.db.prepare("UPDATE memory_items SET deleted_at = ?, updated_at = ?, delete_source = ? WHERE id = ? AND owner = ? AND deleted_at IS NULL").run(now, now, `${source.kind}:${source.ref}`, id, owner);
      changed = Number(r.changes);
      if (changed) this.db.prepare("UPDATE memory_versions SET value = NULL, superseded_at = COALESCE(superseded_at, ?) WHERE item_id = ?").run(now, id);
    });
    return changed > 0;
  }

  /** Raw tombstone check for tests and audits: does a row exist at all, and is any value left? */
  audit(id: string): { exists: boolean; deleted: boolean; values_left: number } {
    const i = this.db.prepare("SELECT deleted_at FROM memory_items WHERE id = ?").get(id) as { deleted_at: string | null } | undefined;
    const n = this.db.prepare("SELECT COUNT(*) AS n FROM memory_versions WHERE item_id = ? AND value IS NOT NULL").get(id) as { n: number };
    return { exists: !!i, deleted: !!i?.deleted_at, values_left: n.n };
  }

  private tx(fn: () => void) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      fn();
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
}
