import { z } from "zod";
import { defineTool } from "./types.ts";
import type { MemoryStore } from "../memory.ts";
import type { RunLog } from "../log.ts";

const Item = z.object({ id: z.string(), key: z.string(), value: z.string(), version: z.number().int(), updated_at: z.string() });
export const ReadMemoryOutput = z.object({ items: z.array(Item) });

/**
 * Read-only view of the caller's memory. The owner is bound here, from the verified token, when
 * the tool is built for one request. The model cannot pass an owner, and there is no write tool.
 */
export function makeReadMemory(store: MemoryStore, owner: string, log: RunLog) {
  return defineTool({
    name: "read_memory",
    description: "Read the current user's saved preferences (for example language and report_format). Read-only. Takes no arguments.",
    input: z.object({}).strict(),
    output: ReadMemoryOutput,
    async run() {
      const items = store.list(owner).map((i) => ({ id: i.id, key: i.key, value: i.value, version: i.version, updated_at: i.updated_at }));
      log.write({ type: "memory_read", owner, items: items.map((i) => ({ id: i.id, key: i.key, value: i.value, version: i.version })) });
      return { items };
    },
  });
}
