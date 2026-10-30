import { z } from "zod";
import { LANGUAGES, REPORT_FORMATS } from "../memory.ts";

/** The assistant ends by calling this pseudo-tool. Its arguments are the structured reply. */
export const FinalAnswer = z
  .object({
    text: z.string().min(1).max(4000),
    language: z.enum(LANGUAGES).describe("Language the text is written in"),
    format: z.enum(REPORT_FORMATS).describe("Layout used for any report in the text"),
    memory_ids_used: z.array(z.string()).max(20).describe("Ids of memory items, returned by read_memory in this run, that shaped the reply"),
  })
  .strict();
export type FinalAnswer = z.infer<typeof FinalAnswer>;

export const FINAL_TOOL_NAME = "final_answer";
export const FINAL_TOOL_DESCRIPTION = "Submit the reply to the user and stop.";
