import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ProdigiApi } from "../prodigi/api.js";
import { z } from "zod";
import { addressSchema, shippingMethodSchema } from "./schemas.js";
import { renderOrder } from "./orders.js";
import { registerTool } from "./error-handler.js";

const orderIdSchema = z
  .string()
  .min(1)
  .describe("The Prodigi order ID, e.g. ord_840797.");

/**
 * Order lifecycle tools.
 *
 * Every one of these is gated by Prodigi's own action checks: once an order
 * enters fulfilment most of them stop working. `prodigi_get_order_actions`
 * should be consulted first so callers do not burn a request on an action that
 * is guaranteed to be rejected.
 */
export function registerOrderActionTools(server: McpServer, api: ProdigiApi): void {
  registerTool(
    server,
    "prodigi_get_order_actions",
    {
      title: "Get available order actions",
      description:
        "Report which changes are still permitted on an order: cancel, change " +
        "recipient details, change shipping method, update metadata. Check this " +
        "before attempting any other action tool - availability shrinks as the " +
        "order progresses through fulfilment, and a rejected action returns " +
        "'actionNotAvailable'.",
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: { prodigiOrderId: orderIdSchema },
    },
    async ({ prodigiOrderId }, extra) => {
      const { actions } = await api.getOrderActions(prodigiOrderId, {
        signal: extra.signal,
      });
      const describe = (v?: { isAvailable?: string }) =>
        v?.isAvailable === "Yes" ? "available" : "no longer available";
      return {
        content: [
          {
            type: "text" as const,
            text:
              `Available actions for ${prodigiOrderId}:\n\n` +
              `- Cancel order: ${describe(actions.cancel)}\n` +
              `- Change recipient details: ${describe(actions.changeRecipientDetails)}\n` +
              `- Change shipping method: ${describe(actions.changeShippingMethod)}\n` +
              `- Update metadata: ${describe(actions.changeMetaData)}`,
          },
        ],
      };
    },
  );

  registerTool(
    server,
    "prodigi_cancel_order",
    {
      title: "Cancel a Prodigi order",
      description:
        "Cancel an entire order. This is irreversible. Before fulfilment the " +
        "full order is refunded; once in fulfilment only the shipping charge is " +
        "refunded, per Prodigi's terms. If only some items can be cancelled the " +
        "order is left active and the shipment results report which ones " +
        "succeeded - check the response carefully. Confirm with the user before " +
        "calling this.",
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
      inputSchema: { prodigiOrderId: orderIdSchema },
    },
    async ({ prodigiOrderId }, extra) => {
      const { outcome, order } = await api.cancelOrder(prodigiOrderId, {
        signal: extra.signal,
      });
      const remaining = (order?.shipments ?? []).filter((s) => s.status !== "Cancelled");
      const note =
        outcome === "Cancelled" && remaining.length > 0
          ? `\n\n**Note:** the order is not fully cancelled - ${remaining.length} ` +
            `shipment(s) remain active. Inspect the shipments above.`
          : "";
      return {
        content: [
          {
            type: "text" as const,
            text:
              `Cancel request completed with outcome "${outcome}".\n\n` +
              (order ? renderOrder(order, "full") : "No order was returned.") +
              note,
          },
        ],
      };
    },
  );

  registerTool(
    server,
    "prodigi_update_shipping_method",
    {
      title: "Update an order's shipping method",
      description:
        "Change the shipping tier on an existing order, e.g. upgrade Budget to " +
        "Express. Only available before the order enters fulfilment - check " +
        "prodigi_get_order_actions first. A quote must already exist for the new " +
        "method or Prodigi may reject the change. Returns a per-shipment result, " +
        "since some shipments may already be locked in.",
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
      inputSchema: {
        prodigiOrderId: orderIdSchema,
        shippingMethod: shippingMethodSchema,
      },
    },
    async ({ prodigiOrderId, shippingMethod }, extra) => {
      const { outcome, order, shipmentUpdateResults } =
        await api.updateShippingMethod(prodigiOrderId, shippingMethod, {
          signal: extra.signal,
        });
      return {
        content: [
          {
            type: "text" as const,
            text:
              `Shipping method change to ${shippingMethod} returned outcome ` +
              `"${outcome}".\n\n` +
              renderShipmentResults(shipmentUpdateResults) +
              "\n" +
              (order ? renderOrder(order, "summary") : ""),
          },
        ],
      };
    },
  );

  registerTool(
    server,
    "prodigi_update_recipient",
    {
      title: "Update an order's recipient",
      description:
        "Replace the name, contact details and address on an existing order. " +
        "All fields are replaced, not merged. Only available before fulfilment - " +
        "check prodigi_get_order_actions first. Include email and phone number on " +
        "international addresses so couriers can clear customs.",
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
      inputSchema: {
        prodigiOrderId: orderIdSchema,
        name: z.string().min(1).describe("Recipient's full name."),
        address: addressSchema,
        email: z.string().email().nullish().describe("Recipient email. Optional."),
        phoneNumber: z
          .string()
          .nullish()
          .describe("Recipient mobile number. Optional."),
      },
    },
    async ({ prodigiOrderId, name, address, email, phoneNumber }, extra) => {
      const { outcome, order, shipmentUpdateResults } = await api.updateRecipient(
        prodigiOrderId,
        { name, address, email, phoneNumber },
        { signal: extra.signal },
      );
      return {
        content: [
          {
            type: "text" as const,
            text:
              `Recipient update returned outcome "${outcome}".\n\n` +
              renderShipmentResults(shipmentUpdateResults) +
              "\n" +
              (order ? renderOrder(order, "summary") : ""),
          },
        ],
      };
    },
  );

  registerTool(
    server,
    "prodigi_update_order_metadata",
    {
      title: "Replace an order's metadata",
      description:
        "Replace the JSON metadata attached to an order. This is a wholesale " +
        "replacement, not a merge - any key not included is removed, so read the " +
        "current order first and send the complete desired object. Unlike the " +
        "other actions this remains available after fulfilment.",
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
      inputSchema: {
        prodigiOrderId: orderIdSchema,
        metadata: z
          .record(z.string(), z.unknown())
          .describe(
            "The complete replacement metadata object. Max 2000 characters.",
          ),
      },
    },
    async ({ prodigiOrderId, metadata }, extra) => {
      const { outcome, order } = await api.updateMetadata(
        prodigiOrderId,
        metadata,
        { signal: extra.signal },
      );
      return {
        content: [
          {
            type: "text" as const,
            text:
              `Metadata update returned outcome "${outcome}".\n\n` +
              (order?.metadata
                ? `Stored metadata: ${JSON.stringify(order.metadata, null, 2)}`
                : "No metadata was returned on the order."),
          },
        ],
      };
    },
  );
}

function renderShipmentResults(
  results: { shipmentId: string; successful: boolean; errorCode?: string; description?: string }[],
): string {
  if (results.length === 0) {
    return "No shipments needed updating (the order had not been allocated to labs yet).";
  }
  const lines = ["## Shipment results"];
  for (const result of results) {
    lines.push(
      result.successful
        ? `- **${result.shipmentId}**: updated`
        : `- **${result.shipmentId}**: NOT updated — ` +
          `${result.errorCode ?? "unknown error"}${result.description ? ` (${result.description})` : ""}`,
    );
  }
  return lines.join("\n");
}
