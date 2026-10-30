import { readFileSync } from "node:fs";
import { z } from "zod";
import { defineTool } from "./types.ts";
import { ToolFailure } from "../errors.ts";

export interface OrdersData {
  dataset: string;
  currency: string;
  weeks: { week: string; regions: { region: string; orders: number; revenue: number }[] }[];
}

export const loadOrders = (): OrdersData => JSON.parse(readFileSync(new URL("../../data/orders.json", import.meta.url), "utf8")) as OrdersData;

export const OrdersReport = z.object({
  week: z.string(),
  currency: z.string(),
  regions: z.array(z.object({ region: z.string(), orders: z.number().int(), revenue: z.number() })),
  total_orders: z.number().int(),
  total_revenue: z.number(),
});
export type OrdersReport = z.infer<typeof OrdersReport>;

export function makeOrdersReport(data: OrdersData = loadOrders()) {
  return defineTool({
    name: "get_orders_report",
    description: "Weekly order figures per region from the synthetic orders dataset. Omit week for the latest week.",
    input: z.object({ week: z.string().regex(/^\d{4}-W\d{2}$/, "ISO week like 2026-W43").optional() }).strict(),
    output: OrdersReport,
    async run({ week }) {
      const w = week ? data.weeks.find((x) => x.week === week) : data.weeks.at(-1);
      if (!w) {
        throw new ToolFailure({ code: "NOT_FOUND", tool: "get_orders_report", message: `no data for ${week}. Available: ${data.weeks.map((x) => x.week).join(", ")}`, retryable: false });
      }
      return {
        week: w.week,
        currency: data.currency,
        regions: w.regions,
        total_orders: w.regions.reduce((s, r) => s + r.orders, 0),
        total_revenue: w.regions.reduce((s, r) => s + r.revenue, 0),
      };
    },
  });
}
