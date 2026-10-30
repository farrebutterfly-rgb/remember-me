import type { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";

/**
 * Conversation history. Append-only record of what was said, including attached documents.
 * It is context for one conversation, not memory: nothing here is ever promoted to a
 * preference, and deleting a memory item does not rewrite what was said.
 */

export type Role = "user" | "assistant" | "document";

export interface StoredMessage {
  id: string;
  conversation_id: string;
  role: Role;
  name: string | null;
  text: string;
  created_at: string;
}

const newId = (p: string) => `${p}_${randomBytes(6).toString("hex")}`;

export class HistoryStore {
  constructor(private readonly db: DatabaseSync, private readonly clock = () => new Date().toISOString()) {}

  create(owner: string): string {
    const id = newId("conv");
    this.db.prepare("INSERT INTO conversations (id, owner, created_at) VALUES (?, ?, ?)").run(id, owner, this.clock());
    return id;
  }

  owns(owner: string, conversationId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM conversations WHERE id = ? AND owner = ?").get(conversationId, owner);
  }

  append(owner: string, conversationId: string, role: Role, text: string, name: string | null = null): StoredMessage {
    if (!this.owns(owner, conversationId)) throw new Error("conversation not found for this owner");
    const m: StoredMessage = { id: newId("msg"), conversation_id: conversationId, role, name, text, created_at: this.clock() };
    this.db.prepare("INSERT INTO messages (id, conversation_id, owner, role, name, text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(m.id, conversationId, owner, role, name, text, m.created_at);
    return m;
  }

  /** Messages of one conversation, oldest first. Undefined when the owner has no such conversation. */
  messages(owner: string, conversationId: string): StoredMessage[] | undefined {
    if (!this.owns(owner, conversationId)) return undefined;
    return this.db
      .prepare("SELECT id, conversation_id, role, name, text, created_at FROM messages WHERE conversation_id = ? AND owner = ? ORDER BY rowid")
      .all(conversationId, owner) as unknown as StoredMessage[];
  }
}
