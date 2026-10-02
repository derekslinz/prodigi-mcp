import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ProdigiApi } from "../prodigi/api.js";
import { z } from "zod";
import { registerTool } from "./error-handler.js";

/**
 * Product discovery tools. These are the entry point for any order: a SKU must
 * be validated before it can be quoted or ordered, because attributes, print
 * areas and shipping destinations all vary per product.
 */
export function registerProductTools(server: McpServer, api: ProdigiApi): void {
  registerTool(
    server,
    "prodigi_get_product",
    {
      title: "Get Prodigi product details",
      description:
        "Look up a Prodigi SKU and return its full definition: description, " +
        "physical dimensions, the product attributes that can be set (e.g. " +
        "frame colour, wrap, size) with every valid value, which print areas " +
        "require an asset, and per-variant shipping destinations plus the " +
        "recommended pixel resolution for each print area. Call this before " +
        "quoting or ordering so the attributes and assets you send are valid.",
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        sku: z
          .string()
          .min(1)
          .describe("The Prodigi SKU, e.g. GLOBAL-CFPM-16X20 or BOOK-A4-L-HARD-M."),
      },
    },
    async ({ sku }, extra) => {
      const { product } = await api.getProduct(sku, { signal: extra.signal });
      return {
        content: [
          {
            type: "text" as const,
            text:
              `# ${product.sku}\n\n` +
              `${product.description}\n\n` +
              `**Size:** ${product.productDimensions.width} x ` +
              `${product.productDimensions.height} ${product.productDimensions.units}\n\n` +
              `## Attributes\n` +
              describeAttributes(product.attributes) +
              `\n## Print areas\n` +
              describePrintAreas(product.printAreas) +
              `\n## Variants\n` +
              describeVariants(product.variants),
          },
        ],
      };
    },
  );

  registerTool(
    server,
    "prodigi_get_spine_info",
    {
      title: "Get photobook spine width",
      description:
        "Calculate the width of a photobook spine in millimetres for a given " +
        "page count and destination country. Use this to generate a spine " +
        "image at the correct size before adding the 'spine' print-area asset " +
        "to a photobook order item. Spine width depends on page count, cover " +
        "type and destination, so it must be looked up rather than estimated.",
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        sku: z
          .string()
          .min(1)
          .describe("The photobook SKU, e.g. BOOK-A4-L-HARD-M."),
        destinationCountryCode: z
          .string()
          .length(2)
          .describe("Two-letter ISO country code of the destination."),
        numberOfPages: z
          .number()
          .int()
          .positive()
          .describe("Total number of pages in the finished book."),
        state: z
          .string()
          .optional()
          .describe(
            "Optional state/province code. Required for some destinations, " +
              "e.g. CA when shipping to the US.",
          ),
      },
    },
    async ({ sku, destinationCountryCode, numberOfPages, state }, extra) => {
      const result = await api.getSpineInfo(
        { sku, destinationCountryCode, numberOfPages, state },
        { signal: extra.signal },
      );
      if (!result.success || !result.spineInfo) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Could not determine spine width: ${result.message ?? "unknown error"}`,
            },
          ],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text:
              `Spine width for ${sku} (${numberOfPages} pages, shipping to ` +
              `${destinationCountryCode}${state ? `/${state}` : ""}): ` +
              `**${result.spineInfo.widthMm} mm**.\n\n` +
              `Generate a spine image at this width, then add it as an asset ` +
              `with printArea "spine" alongside the page assets.`,
          },
        ],
      };
    },
  );
}

function describeAttributes(attributes: Record<string, string[]>): string {
  const keys = Object.keys(attributes);
  if (keys.length === 0) return "This product has no configurable attributes.\n\n";
  return (
    keys
      .map((key) => `- **${key}**: ${attributes[key]!.join(", ")}`)
      .join("\n") + "\n\n"
  );
}

function describePrintAreas(
  printAreas: Record<string, { required: boolean }>,
): string {
  const keys = Object.keys(printAreas);
  if (keys.length === 0) return "No print areas are defined for this product.\n\n";
  return (
    keys
      .map(
        (key) =>
          `- **${key}**: ${printAreas[key]!.required ? "required" : "optional"}`,
      )
      .join("\n") + "\n\n"
  );
}

function describeVariants(
  variants: { attributes: Record<string, string>; shipsTo: string[]; printAreaSizes: Record<string, { horizontalResolution: number; verticalResolution: number }> }[],
): string {
  if (variants.length === 0) return "No variants are published for this product.\n";
  return (
    variants
      .map((variant, index) => {
        const attrs = Object.entries(variant.attributes)
          .map(([k, v]) => `${k}=${v}`)
          .join(", ");
        const sizes = Object.entries(variant.printAreaSizes)
          .map(
            ([area, size]) =>
              `${area}: ${size.horizontalResolution}x${size.verticalResolution}px`,
          )
          .join("; ");
        return [
          `### Variant ${index + 1}${attrs ? ` (${attrs})` : ""}`,
          sizes ? `- Recommended image size: ${sizes}` : null,
          `- Ships to ${variant.shipsTo.length} countries/territories`,
        ]
          .filter(Boolean)
          .join("\n");
      })
      .join("\n\n") + "\n"
  );
}
