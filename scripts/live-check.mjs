#!/usr/bin/env node
/**
 * Exercises the read-only tools against a real Prodigi environment.
 *
 *   PRODIGI_API_KEY=... PRODIGI_ENVIRONMENT=live node scripts/live-check.mjs
 *
 * Deliberately read-only: it calls product, quote and order-read endpoints only.
 * Nothing here creates or modifies an order.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "../dist/prodigi/config.js";
import { createProdigiServer } from "../dist/server.js";

const config = loadConfig();
console.log(
  `environment: ${config.environment}\nbaseUrl:    ${config.baseUrl}\n`,
);

const server = createProdigiServer(config);
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: "live-check", version: "1.0.0" });
await Promise.all([
  server.connect(serverTransport),
  client.connect(clientTransport),
]);

const show = async (title, name, args) => {
  console.log(`\n===== ${title} =====`);
  const result = await client.callTool({ name, arguments: args });
  for (const block of result.content ?? []) {
    console.log(block.type === "text" ? block.text : JSON.stringify(block));
  }
  if (result.isError) console.log("[isError: true]");
  return result;
};

// A missing required attribute. The live API answers HTTP 200 with
// outcome "ValidationFailed"; this must surface as an error, not a quote.
await show("create_quote - missing required attribute", "prodigi_create_quote", {
  destinationCountryCode: "US",
  items: [{ sku: "GLOBAL-CAN-10X10", copies: 1, assets: [{ printArea: "default" }] }],
});

// A well-formed quote.
await show("create_quote - valid, single tier", "prodigi_create_quote", {
  destinationCountryCode: "US",
  currencyCode: "USD",
  shippingMethod: "budget",
  items: [
    {
      sku: "GLOBAL-CAN-10X10",
      copies: 1,
      attributes: { wrap: "Black" },
      assets: [{ printArea: "default" }],
    },
  ],
});

await show("create_quote - all tiers", "prodigi_create_quote", {
  destinationCountryCode: "GB",
  currencyCode: "GBP",
  items: [
    {
      sku: "GLOBAL-CAN-10X10",
      copies: 2,
      attributes: { wrap: "Black" },
      assets: [{ printArea: "default" }],
    },
  ],
});

await show("get_product", "prodigi_get_product", { sku: "GLOBAL-CAN-10X10" });

// Nonexistent order: must be an error rather than an invented order object.
await show("get_order - nonexistent", "prodigi_get_order", {
  prodigiOrderId: "ord_000000",
});

await show("list_orders", "prodigi_list_orders", { maxItems: 5 });

await client.close();
console.log("\nlive check complete");