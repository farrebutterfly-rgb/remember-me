/**
 * The only way a chat message can change memory: the user types a command as the start of
 * their own message. The server parses it before any model sees the turn. Attached documents
 * and assistant output are never parsed for commands, and the model has no write tool.
 *
 *   /remember <key>: <value>     (or <key> = <value>)
 *   /forget <key>
 *   /memories
 */
export type Command =
  | { kind: "remember"; key: string; value: string }
  | { kind: "forget"; key: string }
  | { kind: "list" }
  | { kind: "malformed"; message: string };

export function parseCommand(message: string): Command | undefined {
  const m = message.trimStart();
  if (!m.startsWith("/")) return undefined;
  const [head = "", ...rest] = m.split(/\s+/);
  const body = m.slice(head.length).trim();
  switch (head.toLowerCase()) {
    case "/remember": {
      const kv = /^([A-Za-z0-9_]+)\s*[:=]\s*(.+)$/s.exec(body);
      if (!kv) return { kind: "malformed", message: "usage: /remember <key>: <value>" };
      return { kind: "remember", key: kv[1]!.toLowerCase(), value: kv[2]!.trim() };
    }
    case "/forget":
      if (rest.length !== 1) return { kind: "malformed", message: "usage: /forget <key>" };
      return { kind: "forget", key: rest[0]!.toLowerCase() };
    case "/memories":
      return { kind: "list" };
    default:
      return undefined; // an ordinary message that happens to start with "/"
  }
}
