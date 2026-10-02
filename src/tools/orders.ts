import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ProdigiApi } from "../prodigi/api.js";
import type { Order, OrderItem } from "../prodigi/types.js";
import { z } from "zod";
import {
  brandingSchema,
  orderItemSchema,
  recipientSchema,
  shippingMethodSchema,
  summariseOrderOutcome,
} from "./schemas.js";
import { registerTool } from "./error-handler.js";

/** Order read tools. */
export function registerOrderReadTools(server: McpServer, api: ProdigiApi): void {
  registerTool(
    server,
    "prodigi_get_order",
    {
      title: "Get a Prodigi order",
      description:
        "Fetch a single order by its Prodigi ID (ord_1234567). Returns the " +
        "full order: status stage and per-stage production details, charges, " +
        "shipments with carriers and tracking numbers, recipient, and all line " +
        "items with asset status. Use prodigi_list_orders to discover IDs. " +
        "Returns 'not found' for orders that exist but are held for manual " +
        "approval and have not been released yet.",
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        prodigiOrderId: z
          .string()
          .min(1)
          .describe("The Prodigi order ID, e.g. ord_840797."),
      },
    },
    async ({ prodigiOrderId }, extra) => {
      const { order } = await api.getOrder(prodigiOrderId, { signal: extra.signal });
      return { content: [{ type: "text" as const, text: renderOrder(order, "full") }] };
    },
  );

  registerTool(
    server,
    "prodigi_list_orders",
    {
      title: "List Prodigi orders",
      description:
        "List orders newest-first, with optional filters on creation date range, " +
        "status, specific order IDs, or your own merchant references. Paginates " +
        "automatically up to maxItems and returns a compact summary per order " +
        "rather than the full object - call prodigi_get_order for detail. " +
        "Note: accounts configured for manual order approval do not see " +
        "submitted orders here - they only become visible once released. An " +
        "empty result may therefore mean 'awaiting approval', not 'none exist'.",
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        status: z
          .enum(["draft", "awaitingPayment", "inProgress", "complete", "cancelled"])
          .optional()
          .describe("Limit to orders in this status."),
        createdFrom: z
          .string()
          .optional()
          .describe(
            "ISO 8601 UTC timestamp, e.g. 2024-01-01T00:00:00Z. " +
              "Only orders created at or after this time.",
          ),
        createdTo: z
          .string()
          .optional()
          .describe("ISO 8601 UTC timestamp. Only orders created before this time."),
        orderIds: z
          .array(z.string())
          .optional()
          .describe("Specific Prodigi order IDs to fetch."),
        merchantReferences: z
          .array(z.string())
          .optional()
          .describe("Your own order references to filter by."),
        skip: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("Records to skip before the first page. Default 0."),
        maxItems: z
          .number()
          .int()
          .positive()
          .max(500)
          .default(20)
          .describe(
            "Maximum number of orders to return across pages. Default 20, " +
              "maximum 500.",
          ),
      },
    },
    async (args, extra) => {
      const { items, hasMore } = await api.listOrders(
        {
          status: args.status,
          createdFrom: args.createdFrom,
          createdTo: args.createdTo,
          orderIds: args.orderIds,
          merchantReferences: args.merchantReferences,
          skip: args.skip,
        },
        { maxItems: args.maxItems, signal: extra.signal },
      );

      if (items.length === 0) {
        const filtered =
          args.status ||
          args.createdFrom ||
          args.createdTo ||
          args.orderIds?.length ||
          args.merchantReferences?.length;
        return {
          content: [
            {
              type: "text" as const,
              text:
                filtered
                  ? "No orders matched the given filters."
                  : "No orders are visible to this API key.\n\n" +
                    "If this account is configured for manual order approval, " +
                    "submitted orders stay hidden until they are released - an " +
                    "empty list is then expected rather than an error.",
            },
          ],
        };
      }

      const header = `Found ${items.length} order(s)${hasMore ? " (more available - raise maxItems to see them)" : ""}.\n\n`;
      return {
        content: [
          {
            type: "text" as const,
            text: header + items.map((o) => renderOrder(o, "summary")).join("\n\n"),
          },
        ],
      };
    },
  );
}

/** Order mutation tools. These place real, billable orders. */
export function registerOrderWriteTools(server: McpServer, api: ProdigiApi): void {
  registerTool(
    server,
    "prodigi_create_order",
    {
      title: "Create a Prodigi order",
      description:
        "Submit a real order to the Prodigi print network. This incurs charges " +
        "and starts fulfilment as soon as the configured pause window expires, " +
        "so it should only be called after the customer has committed to " +
        "purchasing. Validate every SKU with prodigi_get_product and price the " +
        "basket with prodigi_create_quote first. Each item needs at least one " +
        "asset URL that is publicly downloadable.",
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputSchema: {
        recipient: recipientSchema,
        items: z
          .array(orderItemSchema)
          .min(1)
          .describe("Products to print and ship."),
        shippingMethod: shippingMethodSchema,
        merchantReference: z
          .string()
          .optional()
          .describe(
            "Your own reference for this order, e.g. your internal order " +
              "number. Echoed back on every callback. Note: duplicate detection " +
              "uses idempotencyKey, not this field.",
          ),
        idempotencyKey: z
          .string()
          .optional()
          .describe(
            "A unique key (e.g. a GUID) for this order. If Prodigi has already " +
              "seen the key it returns the existing order instead of creating a " +
              "duplicate, which makes retries safe. Recommended for any system " +
              "where exactly-once submission cannot otherwise be guaranteed.",
          ),
        callbackUrl: z
          .string()
          .url()
          .optional()
          .describe(
            "Public HTTPS URL to receive CloudEvents callbacks when the order " +
              "stage changes. Overrides the account-wide default.",
          ),
        branding: brandingSchema.optional(),
        metadata: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(
            "Arbitrary JSON (max 2000 characters) stored on the order and " +
              "returned in callbacks. Useful for round-tripping your own " +
              "internal context.",
          ),
      },
    },
    async (args, extra) => {
      const { outcome, order, traceParent } = await api.createOrder(args, {
        signal: extra.signal,
      });

      if (!order) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                `The API accepted the request (outcome "${outcome}") but ` +
                `returned no order object.` +
                (traceParent ? ` traceParent: ${traceParent}` : ""),
            },
          ],
          isError: true,
        };
      }

      const warning =
        outcome === "CreatedWithIssues" ? renderIssues(order) : "";

      return {
        content: [
          {
            type: "text" as const,
            text:
              `${summariseOrderOutcome(outcome)}\n\n` +
              renderOrder(order, "full") +
              warning,
          },
        ],
      };
    },
  );
}

function renderIssues(order: Order): string {
  const issues = order.status?.issues ?? [];
  if (issues.length === 0) return "";
  return (
    `\n## Issues needing attention\n` +
    issues
      .map(
        (issue) =>
          `- **${issue.errorCode}**${issue.objectId ? ` on ${issue.objectId}` : ""}: ` +
          issue.description,
      )
      .join("\n")
  );
}

export function renderOrder(order: Order, verbosity: "summary" | "full"): string {
  const lines: string[] = [];

  lines.push(`# Order ${order.id}`);
  lines.push(
    `- **Status:** ${order.status?.stage ?? "unknown"}` +
      (order.merchantReference
        ? `  ·  **Your reference:** ${order.merchantReference}`
        : ""),
  );
  lines.push(`- **Created:** ${order.created}`);
  lines.push(`- **Shipping method:** ${order.shippingMethod}`);
  if (order.status?.details) {
    const d = order.status.details;
    lines.push(
      `- **Production:** assets ${d.downloadAssets}, prep ` +
        `${d.printReadyAssetsPrepared}, lab allocation ${d.allocateProductionLocation}, ` +
        `production ${d.inProduction}, shipping ${d.shipping}`,
    );
  }

  const recipient = order.recipient;
  if (recipient) {
    lines.push(
      `- **Recipient:** ${recipient.name} — ${recipient.address?.townOrCity ?? ""}, ` +
        `${recipient.address?.postalOrZipCode ?? ""}, ${recipient.address?.countryCode ?? ""}`,
    );
  }

  if (verbosity === "full") {
    const items = order.items ?? [];
    lines.push("", "## Items");
    if (items.length === 0) {
      lines.push("_This order has no items._");
    } else {
      for (const item of items) {
        lines.push(
          ...renderItem(item, order.status?.issues ?? []),
        );
      }
    }

    if (order.shipments && order.shipments.length > 0) {
      lines.push("", "## Shipments");
      for (const shipment of order.shipments) {
        const carrier = shipment.carrier
          ? `${shipment.carrier.name} / ${shipment.carrier.service}`
          : "carrier pending";
        const lab = shipment.fulfillmentLocation
          ? `${shipment.fulfillmentLocation.countryCode}/${shipment.fulfillmentLocation.labCode}`
          : "lab pending";
        lines.push(
          `- **${shipment.id}** — ${shipment.status}, ${carrier} from ${lab}` +
            (shipment.dispatchDate ? `, dispatched ${shipment.dispatchDate}` : ""),
        );
        if (shipment.tracking?.number) {
          const link = shipment.tracking.url
            ? `[${shipment.tracking.number}](${shipment.tracking.url})`
            : shipment.tracking.number;
          lines.push(`  - Tracking: ${link}`);
        }
        lines.push(`  - Items: ${shipment.items.map((i) => i.itemId).join(", ")}`);
      }
    }

    if (order.charges && order.charges.length > 0) {
      lines.push("", "## Charges");
      for (const charge of order.charges) {
        const total = charge.totalCost
          ? `${charge.totalCost.amount} ${charge.totalCost.currency}`
          : "unknown";
        lines.push(
          `- ${charge.chargeType ?? "charge"}${charge.prodigiInvoiceNumber ? ` (invoice ${charge.prodigiInvoiceNumber})` : ""}: ${total}`,
        );
        for (const item of charge.items ?? []) {
          lines.push(
            `  - ${item.itemId ?? item.shipmentId ?? "item"}: ` +
              `${item.cost.amount} ${item.cost.currency}`,
          );
        }
      }
    }

    if (order.metadata && Object.keys(order.metadata).length > 0) {
      lines.push("", "## Metadata", JSON.stringify(order.metadata, null, 2));
    }

    const issues = order.status?.issues ?? [];
    if (issues.length > 0) {
      lines.push("", "## Issues");
      for (const issue of issues) {
        lines.push(
          `- **${issue.errorCode}**${issue.objectId ? ` on ${issue.objectId}` : ""}: ${issue.description}`,
        );
        if (issue.authorisationDetails) {
          lines.push(
            `  - Authorise ${issue.authorisationDetails.paymentDetails.amount} ` +
              `${issue.authorisationDetails.paymentDetails.currency} at ` +
              `${issue.authorisationDetails.authorisationUrl}`,
          );
        }
      }
    }
  } else {
    const itemSummary = (order.items ?? [])
      .map((i) => `${i.sku} x${i.copies}`)
      .join(", ");
    if (itemSummary) lines.push(`- **Items:** ${itemSummary}`);
    if (order.shipments && order.shipments.length > 0) {
      lines.push(`- **Shipments:** ${order.shipments.length}`);
    }
  }

  return lines.join("\n");
}

function renderItem(item: OrderItem, issues: { objectId?: string; errorCode: string; description: string }[]): string[] {
  const attrs = Object.entries(item.attributes ?? {});
  const attrText =
    attrs.length > 0
      ? ` [${attrs.map(([k, v]) => `${k}=${v}`).join(", ")}]`
      : "";
  const assetText = (item.assets ?? [])
    .map(
      (a) =>
        `\`${a.printArea}\`${a.status ? ` (${a.status})` : ""}` +
        `${a.pageCount ? ` ${a.pageCount}p` : ""}`,
    )
    .join(", ");
  const itemIssues = issues.filter(
    (i) => i.objectId && i.objectId === item.id,
  );

  const lines = [
    `- **${item.id}** — \`${item.sku}\`${attrText} x${item.copies} [${item.status}]`,
    `  - Sizing: ${item.sizing}; assets: ${assetText || "none"}`,
  ];
  if (item.recipientCost) {
    lines.push(
      `  - Charged to recipient: ${item.recipientCost.amount} ${item.recipientCost.currency}`,
    );
  }
  for (const issue of itemIssues) {
    lines.push(`  - Issue **${issue.errorCode}**: ${issue.description}`);
  }
  return lines;
}
