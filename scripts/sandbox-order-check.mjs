#!/usr/bin/env node
/**
 * Exercises the full order lifecycle against a real Prodigi SANDBOX account:
 * create -> get -> list -> actions -> update shipping -> update recipient ->
 * update metadata -> cancel.
 *
 *   PRODIGI_API_KEY=... PRODIGI_ENVIRONMENT=sandbox node scripts/sandbox-order-check.mjs
 *
 * Safety: this refuses to run against `live` unless PRODIGI_ALLOW_LIVE is set,
 * because every order it creates would be produced, shipped and billed.
 *
 * Sandbox orders are never fulfilled and never charged, so the image URL only
 * needs to resolve; Prodigi will attempt to download it and report the result
 * in the order status rather than rejecting the order outright.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "../dist/prodigi/config.js";
import { createProdigiServer } from "../dist/server.js";

const config = loadConfig();

if (config.environment === "live" && process.env.PRODIGI_ALLOW_LIVE !== "1") {
  console.error(
    "Refusing to run: this script CREATES real orders.\n" +
      "Sandbox orders are never fulfilled or charged, so run it there.\n" +
      "Set PRODIGI_ALLOW_LIVE=1 only if you truly mean to bill real orders.",
  );
  process.exit(1);
}

console.log(`environment: ${config.environment}\nbaseUrl:    ${config.baseUrl}\n`);

const server = createProdigiServer(config);
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: "sandbox-order-check", version: "1.0.0" });
await Promise.all([
  server.connect(serverTransport),
  client.connect(clientTransport),
]);

const call = async (name, args) => {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  return { isError: result.isError === true, text };
};

const step = async (title, name, args) => {
  console.log(`\n===== ${title} =====`);
  const { isError, text } = await call(name, args);
  console.log(text);
  if (isError) console.log("[isError: true]");
  return { isError, text };
};

const SKU = process.env.PRODIGI_TEST_SKU ?? "GLOBAL-CAN-10X10";
const IMAGE =
  process.env.PRODIGI_TEST_IMAGE ??
  "https://pwintyimages.blob.core.windows.net/samples/stars/test-sample-grey.png";

/**
 * Attributes are product-specific and every one is required, so this mirrors
 * the first variant of the SKU above. Override if you point this at another
 * product with a different attribute set.
 */
const ATTRIBUTES = {
  edge: "38mm",
  frame: "38mm standard stretcher bar",
  paperType: "Standard canvas (SC)",
  substrateWeight: "400gsm",
  wrap: "Black",
};

await step("get_product (confirm attribute set)", "prodigi_get_product", {
  sku: SKU,
});

await step("create_quote (all tiers)", "prodigi_create_quote", {
  destinationCountryCode: "US",
  currencyCode: "USD",
  items: [
    {
      sku: SKU,
      copies: 1,
      attributes: ATTRIBUTES,
      assets: [{ printArea: "default" }],
    },
  ],
});

const created = await step("create_order", "prodigi_create_order", {
  recipient: {
    name: "Sandbox Test Recipient",
    email: "sandbox-test@example.com",
    phoneNumber: "+15555550123",
    address: {
      line1: "14 Test Place",
      line2: "Testville",
      postalOrZipCode: "12345",
      countryCode: "US",
      townOrCity: "Somewhere",
      stateOrCounty: "CA",
    },
  },
  shippingMethod: "Budget",
  merchantReference: `sandbox-check-${Date.now()}`,
  idempotencyKey: `sandbox-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
  items: [
    {
      sku: SKU,
      copies: 1,
      sizing: "fillPrintArea",
      attributes: ATTRIBUTES,
      assets: [{ printArea: "default", url: IMAGE }],
      recipientCost: { amount: "50.00", currency: "USD" },
    },
  ],
  metadata: { harness: "sandbox-order-check", note: "safe to ignore" },
});

// Pull the order ID and merchant reference out of the rendered output.
const orderId = created.text.match(/ord_\d+/)?.[0];
const merchantReference = created.text.match(/sandbox-check-\d+/)?.[0];
if (!orderId) {
  console.error(
    `\nCould not determine an order ID from create_order output. Stopping.\n${created.text}`,
  );
  await client.close();
  process.exit(1);
}
console.log(`\n[captured order id: ${orderId}]`);

await step("get_order", "prodigi_get_order", { prodigiOrderId: orderId });

await step("list_orders (filter by this id)", "prodigi_list_orders", {
  orderIds: [orderId],
  maxItems: 5,
});

if (merchantReference) {
  await step("list_orders (filter by merchantReference)", "prodigi_list_orders", {
    merchantReferences: [merchantReference],
    maxItems: 5,
  });
}

await step("get_order_actions", "prodigi_get_order_actions", { prodigiOrderId: orderId });

await step("update_shipping_method", "prodigi_update_shipping_method", {
  prodigiOrderId: orderId,
  shippingMethod: "Standard",
});

await step("update_recipient", "prodigi_update_recipient", {
  prodigiOrderId: orderId,
  name: "Sandbox Renamed Recipient",
  email: "renamed@example.com",
  phoneNumber: "+15555550999",
  address: {
    line1: "99 Revised Street",
    line2: "Revised",
    postalOrZipCode: "54321",
    // Must stay in the original country: Prodigi rejects a destination
    // country change with ChangeOfDestinationCountryNotPossible.
    countryCode: "US",
    townOrCity: "Revisville",
    stateOrCounty: "NY",
  },
});

await step("update_order_metadata", "prodigi_update_order_metadata", {
  prodigiOrderId: orderId,
  metadata: { harness: "sandbox-order-check", stage: "metadata-updated" },
});

await step("get_order (verify updates)", "prodigi_get_order", { prodigiOrderId: orderId });

await step("cancel_order", "prodigi_cancel_order", { prodigiOrderId: orderId });

await step("get_order_actions (after cancel)", "prodigi_get_order_actions", {
  prodigiOrderId: orderId,
});

await client.close();
console.log(`\nsandbox order lifecycle complete for ${orderId}`);
console.log("This order was never fulfilled and incurs no charge.");