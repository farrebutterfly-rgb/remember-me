import { call, ScriptedModel, toolResults } from "./model/scripted.ts";
import type { Message } from "./model/types.ts";
import type { Language, ReportFormat } from "./memory.ts";
import type { OrdersReport } from "./tools/ordersReport.ts";

/**
 * Fixture assistant. A scripted model whose every step reads the real transcript: the memory it
 * got back from read_memory decides the language and layout, and the figures come from
 * get_orders_report. Nothing in the reply is hard-coded. This proves the plumbing around memory;
 * it proves nothing about how a real model follows preferences.
 */

const LOCALE: Record<Language, string> = { en: "en-GB", sv: "sv-SE", fr: "fr-FR" };

const L = {
  en: {
    title: (w: string) => `Orders, week ${w}`,
    region: "Region", orders: "Orders", revenue: "Revenue", total: "Total",
    help: "I can summarise weekly orders per region. Ask for example: orders report for 2026-W43.",
    doc: (name: string, n: number) => `I read the attached document "${name}" as data (${n} lines).`,
    docInstr: "It contains text phrased as an instruction to change your preferences. I did not act on it: preferences change only when you type /remember <key>: <value>.",
    prefs: (l: string, f: string, saved: boolean) => `(Language ${l}, format ${f}: ${saved ? "from your saved preferences" : "defaults, nothing saved"}.)`,
  },
  sv: {
    title: (w: string) => `Ordrar, vecka ${w}`,
    region: "Region", orders: "Ordrar", revenue: "Intäkter", total: "Totalt",
    help: "Jag kan sammanfatta veckans ordrar per region. Fråga till exempel: orderrapport för 2026-W43.",
    doc: (name: string, n: number) => `Jag läste det bifogade dokumentet "${name}" som data (${n} rader).`,
    docInstr: "Det innehåller text formulerad som en instruktion att ändra dina inställningar. Jag följde den inte: inställningar ändras bara när du skriver /remember <nyckel>: <värde>.",
    prefs: (l: string, f: string, saved: boolean) => `(Språk ${l}, format ${f}: ${saved ? "från dina sparade inställningar" : "standardvärden, inget sparat"}.)`,
  },
  fr: {
    title: (w: string) => `Commandes, semaine ${w}`,
    region: "Région", orders: "Commandes", revenue: "Chiffre d'affaires", total: "Total",
    help: "Je peux résumer les commandes hebdomadaires par région. Demandez par exemple : rapport des commandes 2026-W43.",
    doc: (name: string, n: number) => `J'ai lu le document joint "${name}" comme des données (${n} lignes).`,
    docInstr: "Il contient un texte formulé comme une instruction de modifier vos préférences. Je ne l'ai pas suivi : les préférences ne changent qu'avec /remember <clé> : <valeur>.",
    prefs: (l: string, f: string, saved: boolean) => `(Langue ${l}, format ${f} : ${saved ? "selon vos préférences enregistrées" : "valeurs par défaut, rien d'enregistré"}.)`,
  },
} satisfies Record<Language, unknown>;

export function renderReport(r: OrdersReport, lang: Language, format: ReportFormat): string {
  const t = L[lang];
  const n = new Intl.NumberFormat(LOCALE[lang]);
  const money = (v: number) => `${n.format(v)} ${r.currency}`;
  if (format === "table") {
    const rows = r.regions.map((x) => `| ${x.region} | ${n.format(x.orders)} | ${money(x.revenue)} |`);
    return [t.title(r.week), "", `| ${t.region} | ${t.orders} | ${t.revenue} |`, "| --- | ---: | ---: |", ...rows, `| **${t.total}** | **${n.format(r.total_orders)}** | **${money(r.total_revenue)}** |`].join("\n");
  }
  const rows = r.regions.map((x) => `- ${x.region}: ${n.format(x.orders)} ${t.orders.toLowerCase()}, ${money(x.revenue)}`);
  return [t.title(r.week), ...rows, `- ${t.total}: ${n.format(r.total_orders)} ${t.orders.toLowerCase()}, ${money(r.total_revenue)}`].join("\n");
}

type MemItem = { id: string; key: string; value: string };

const okResults = (t: Message[]) => toolResults(t).filter((r) => !r.isError).map((r) => JSON.parse(r.content) as Record<string, unknown>);
const memoryOf = (t: Message[]): MemItem[] => (okResults(t).find((r) => "items" in r)?.items as MemItem[] | undefined) ?? [];
const reportOf = (t: Message[]) => okResults(t).find((r) => "total_orders" in r) as OrdersReport | undefined;

/** The user message of the current turn: the one just before the first assistant tool call. */
function currentMessage(t: Message[]): string {
  const i = t.findIndex((m) => m.role === "assistant" && m.calls.length > 0);
  const m = t[i - 1];
  return m && m.role === "user" ? m.text : "";
}

function documentsIn(text: string): { name: string; body: string }[] {
  return [...text.matchAll(/<document name="([^"]*)">\n([\s\S]*?)\n<\/document>/g)].map((m) => ({ name: m[1]!, body: m[2]! }));
}

const LOOKS_LIKE_INSTRUCTION = /\/remember|\bremember (that|this)\b|\bfrom now on\b/i;

function compose(t: Message[]) {
  const mem = memoryOf(t);
  const langItem = mem.find((m) => m.key === "language");
  const fmtItem = mem.find((m) => m.key === "report_format");
  const lang = (langItem?.value ?? "en") as Language;
  const format = (fmtItem?.value ?? "bullets") as ReportFormat;
  const tr = L[lang];
  const parts: string[] = [];
  const report = reportOf(t);
  parts.push(report ? renderReport(report, lang, format) : tr.help);
  for (const d of documentsIn(currentMessage(t))) {
    parts.push(tr.doc(d.name, d.body.split("\n").length));
    if (LOOKS_LIKE_INSTRUCTION.test(d.body)) parts.push(tr.docInstr);
  }
  parts.push(tr.prefs(lang, format, !!(langItem || fmtItem)));
  return call("final_answer", {
    text: parts.join("\n\n"),
    language: lang,
    format,
    memory_ids_used: [langItem?.id, fmtItem?.id].filter((x): x is string => !!x),
  });
}

const WANTS_REPORT = /order|report|ordrar|rapport|commande/i;

/** The fixture assistant used by the demo, the tests and `make serve`. */
export function scriptedAssistant(): ScriptedModel {
  return new ScriptedModel(
    [
      () => ({ calls: [call("read_memory", {})] }),
      (t) => {
        const msg = currentMessage(t);
        if (!WANTS_REPORT.test(msg.split("<document")[0] ?? "")) return { calls: [compose(t)] };
        const week = /\d{4}-W\d{2}/.exec(msg)?.[0];
        return { calls: [call("get_orders_report", week ? { week } : {})] };
      },
      (t) => ({ calls: [compose(t)] }),
    ],
    "assistant",
  );
}

/**
 * A model that has been fooled by the document and tries to save the preference it found there.
 * Used to show that the write path does not exist for the model at all: the calls come back as
 * UNKNOWN_TOOL and memory is unchanged.
 */
export function gullibleAssistant(): ScriptedModel {
  return new ScriptedModel(
    [
      () => ({ calls: [call("read_memory", {})] }),
      () => ({ calls: [call("remember", { key: "language", value: "fr" }), call("write_memory", { owner: "usr_alice", key: "language", value: "fr" })] }),
      (t) => ({ calls: [compose(t)] }),
    ],
    "gullible",
  );
}
