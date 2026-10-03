import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ProdigiApi } from "../prodigi/api.js";
import type { Quote } from "../prodigi/types.js";
import { z } from "zod";
import { attributesSchema, quoteAssetSchema, quoteShippingMethodSchema } from "./schemas.js";
import { registerTool } from "./error-handler.js";

/**
 * Quoting tools. A quote prices a basket and shows which labs and couriers
 * would fulfil it, without creating an order - always quote before ordering.
 */
export function registerQuoteTools(server: McpServer, api: ProdigiApi): void {
  registerTool(
    server,
    "prodigi_create_quote",
    {
      title: "Quote a Prodigi order",
      description:
        "Price a basket of products for a destination country without creating " +
        "an order. Returns one quote per shipping method, each with the item " +
        "cost, shipping cost, per-shipment courier and fulfilling lab, and the " +
        "per-item unit cost. Use this to show a customer their options and to " +
        "confirm the basket is valid - a quote that succeeds is strong evidence " +
        "the SKUs, attributes and destination all work. Omit shippingMethod to " +
        "get all tiers for comparison.",
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      inputSchema: {
        destinationCountryCode: z
          .string()
          .length(2)
          .describe(
            "Two-letter ISO country code of the destination. Drives available " +
              "labs, couriers and cost.",
          ),
        items: z
          .array(
            z.object({
              sku: z.string().min(1).describe("Prodigi SKU to quote."),
              copies: z.number().int().positive().describe("Quantity."),
              attributes: attributesSchema.optional(),
              assets: z
                .array(quoteAssetSchema)
                .min(1)
                .describe(
                  "Print areas this product occupies. Match the required print " +
                    "areas reported by prodigi_get_product.",
                ),
            }),
          )
          .min(1)
          .describe("The basket to price. At least one item is required."),
        shippingMethod: quoteShippingMethodSchema
          .optional()
          .describe("Restrict to a single shipping tier. Omit for all tiers."),
        currencyCode: z
          .string()
          .length(3)
          .optional()
          .describe(
            "Three-letter ISO currency to price in. Defaults to the currency " +
              "configured in your Prodigi merchant settings.",
          ),
      },
    },
    async (args, extra) => {
      const result = await api.createQuote(args, { signal: extra.signal });

      if (result.quotes.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                `No quotes were returned for destination ` +
                `${args.destinationCountryCode}. The basket may use a SKU that ` +
                `is unavailable there, or attributes that do not exist for it. ` +
                `Check each SKU with prodigi_get_product.`,
            },
          ],
          isError: true,
        };
      }

      const issueText =
        result.issues.length > 0
          ? `\n\n## Issues\n${result.issues
              .map(
                (i) =>
                  `- **${i.errorCode}**${i.objectId ? ` on ${i.objectId}` : ""}: ` +
                  `${i.description}`,
              )
              .join("\n")}`
          : "";

      return {
        content: [
          {
            type: "text" as const,
            text:
              `Quoted ${result.quotes.length} shipping option(s) for ` +
              `${args.items.length} line item(s) to ${args.destinationCountryCode}.\n\n` +
              result.quotes.map(renderQuote).join("\n\n---\n\n") +
              issueText,
          },
        ],
      };
    },
  );
}

function renderQuote(quote: Quote): string {
  const { items, shipping, branding, totalCost, totalTax } = quote.costSummary;
  // Prefer the server's own total when present; it accounts for branding and tax
  // that a naive items+shipping sum would miss.
  const total =
    totalCost?.amount ?? addCosts(items, shipping);

  const lines: string[] = [
    `## ${quote.shipmentMethod}`,
    `- **Items:** ${items.amount} ${items.currency}`,
    `- **Shipping:** ${shipping.amount} ${shipping.currency}`,
  ];
  if (branding && Number.parseFloat(branding.amount) !== 0) {
    lines.push(`- **Branding:** ${branding.amount} ${branding.currency}`);
  }
  lines.push(`- **Total:** ${total} ${totalCost?.currency ?? items.currency}`);
  if (totalTax && Number.parseFloat(totalTax.amount) !== 0) {
    lines.push(`- **Tax:** ${totalTax.amount} ${totalTax.currency}`);
  }
  lines.push("", "### Fulfilment plan");

  if (quote.shipments.length === 0) {
    lines.push("_No shipments were planned for this method._");
  } else {
    for (const shipment of quote.shipments) {
      lines.push(
        `- **${shipment.carrier.name} / ${shipment.carrier.service}** from ` +
          `${shipment.fulfillmentLocation.countryCode} lab ` +
          `${shipment.fulfillmentLocation.labCode} — ` +
          `${shipment.cost.amount} ${shipment.cost.currency} ` +
          `(items: ${shipment.items.join(", ")})`,
      );
    }
  }

  lines.push("", "### Items");
  for (const item of quote.items) {
    const attrs = Object.entries(item.attributes ?? {});
    const attrText =
      attrs.length > 0
        ? ` [${attrs.map(([k, v]) => `${k}=${v}`).join(", ")}]`
        : "";
    const pages = item.assets
      .map((a) => (a.pageCount ? `${a.printArea} (${a.pageCount}p)` : a.printArea))
      .join(", ");
    lines.push(
      `- \`${item.sku}\`${attrText} x${item.copies} @ ` +
        `${item.unitCost.amount} ${item.unitCost.currency} each ` +
        `— print areas: ${pages}`,
    );
  }

  return lines.join("\n");
}

/** Sums two same-currency costs. Falls back to a dash if currencies differ. */
function addCosts(a: { amount: string; currency: string }, b: { amount: string; currency: string }): string {
  if (a.currency !== b.currency) return "n/a";
  const total = Number.parseFloat(a.amount) + Number.parseFloat(b.amount);
  return Number.isFinite(total) ? total.toFixed(2) : "n/a";
}
