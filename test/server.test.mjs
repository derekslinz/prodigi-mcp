import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createProdigiServer } from "../dist/server.js";

const CONFIG = {
  apiKey: "test-key",
  environment: "sandbox",
  baseUrl: "https://api.sandbox.prodigi.com/v4.0",
  timeoutMs: 1000,
};

/**
 * Connects an MCP client to a Prodigi server whose HTTP layer is stubbed, so
 * tool wiring, argument validation and result formatting are all exercised
 * without touching the network.
 */
async function connect(responses) {
  const calls = [];
  let index = 0;
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    const spec = responses[Math.min(index++, responses.length - 1)];
    return new Response(
      spec?.body === undefined ? "" : JSON.stringify(spec.body),
      {
        status: spec?.status ?? 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  };

  const server = createProdigiServer(CONFIG, fetchImpl);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return { client, calls };
}

const PRODUCT_RESPONSE = {
  outcome: "Ok",
  product: {
    sku: "GLOBAL-CAN-10X10",
    description: "Standard canvas on quality stretcher bar, 25x25cm",
    productDimensions: { width: 10, height: 10, units: "in" },
    attributes: { wrap: ["Black", "ImageWrap", "MirrorWrap", "White"] },
    printAreas: { default: { required: true } },
    variants: [
      {
        attributes: { wrap: "Black" },
        shipsTo: ["GB", "US"],
        printAreaSizes: {
          default: { horizontalResolution: 1522, verticalResolution: 1522 },
        },
      },
    ],
  },
};

const QUOTE_RESPONSE = {
  outcome: "Created",
  quotes: [
    {
      shipmentMethod: "Budget",
      costSummary: {
        items: { amount: "7.50", currency: "GBP" },
        shipping: { amount: "1.50", currency: "GBP" },
      },
      shipments: [
        {
          carrier: { name: "royalmail", service: "Standard" },
          fulfillmentLocation: { countryCode: "GB", labCode: "uk6" },
          cost: { amount: "1.50", currency: "GBP" },
          items: ["qit_1"],
        },
      ],
      items: [
        {
          id: "qit_1",
          sku: "GLOBAL-CAN-10X10",
          copies: 1,
          unitCost: { amount: "7.50", currency: "GBP" },
          attributes: {},
          assets: [{ printArea: "default" }],
        },
      ],
    },
  ],
};

const ORDER_RESPONSE = {
  outcome: "Created",
  order: {
    id: "ord_840797",
    created: "2021-03-11T14:40:05.12Z",
    merchantReference: "MY-REF-1",
    shippingMethod: "Budget",
    status: {
      stage: "InProgress",
      issues: [],
      details: {
        downloadAssets: "NotStarted",
        printReadyAssetsPrepared: "NotStarted",
        allocateProductionLocation: "NotStarted",
        inProduction: "NotStarted",
        shipping: "NotStarted",
      },
    },
    charges: [],
    shipments: [],
    recipient: {
      name: "Mr Test",
      address: {
        line1: "14 test place",
        postalOrZipCode: "12345",
        countryCode: "US",
        townOrCity: "somewhere",
      },
    },
    items: [
      {
        id: "ori_926887",
        status: "NotYetDownloaded",
        sku: "GLOBAL-CAN-10X10",
        copies: 1,
        sizing: "fillPrintArea",
        attributes: { wrap: "Black" },
        assets: [{ printArea: "default", status: "InProgress" }],
      },
    ],
  },
};

function text(result) {
  return (result.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

describe("MCP server surface", () => {
  it("advertises every Prodigi tool with descriptions", async () => {
    const { client } = await connect([]);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();

    assert.deepEqual(names, [
      "prodigi_cancel_order",
      "prodigi_create_order",
      "prodigi_create_quote",
      "prodigi_get_configuration",
      "prodigi_get_order",
      "prodigi_get_order_actions",
      "prodigi_get_product",
      "prodigi_get_spine_info",
      "prodigi_list_orders",
      "prodigi_update_order_metadata",
      "prodigi_update_recipient",
      "prodigi_update_shipping_method",
    ]);

    for (const tool of tools) {
      assert.ok(tool.description?.length > 40, `${tool.name} needs a description`);
    }
    await client.close();
  });

  it("exposes the workflow guide and environment as resources", async () => {
    const { client } = await connect([]);
    const { resources } = await client.listResources();
    const uris = resources.map((r) => r.uri);
    assert.ok(uris.includes("prodigi://guide/workflow"));
    assert.ok(uris.includes("prodigi://config/environment"));

    const guide = await client.readResource({ uri: "prodigi://guide/workflow" });
    assert.match(guide.contents[0].text, /create_quote/);

    const env = await client.readResource({ uri: "prodigi://config/environment" });
    assert.match(env.contents[0].text, /sandbox/);
    assert.doesNotMatch(env.contents[0].text, /test-key/);

    const templates = await client.listResourceTemplates();
    assert.ok(
      templates.resourceTemplates.some((t) => t.uriTemplate.includes("{sku}")),
    );
    await client.close();
  });

  it("marks the configuration tool read-only and orders as destructive", async () => {
    const { client } = await connect([]);
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

    assert.equal(byName["prodigi_create_order"].annotations.destructiveHint, true);
    assert.equal(byName["prodigi_cancel_order"].annotations.destructiveHint, true);
    assert.equal(byName["prodigi_get_product"].annotations.readOnlyHint, true);
    assert.equal(byName["prodigi_create_quote"].annotations.readOnlyHint, true);
    await client.close();
  });

  it("rejects an invalid shipping method before calling the API", async () => {
    const { client, calls } = await connect([]);
    const result = await client.callTool({
      name: "prodigi_create_order",
      arguments: {
        recipient: {
          name: "A",
          address: {
            line1: "x",
            postalOrZipCode: "1",
            countryCode: "USA",
            townOrCity: "y",
          },
        },
        shippingMethod: "Teleport",
        items: [
          { sku: "GLOBAL-CAN-10X10", copies: 1, assets: [{ url: "https://x/y.png" }] },
        ],
      },
    });
    assert.equal(result.isError, true);
    assert.equal(calls.length, 0, "invalid input must not reach the network");
    await client.close();
  });

  it("renders a product definition", async () => {
    const { client, calls } = await connect([{ body: PRODUCT_RESPONSE }]);
    const result = await client.callTool({
      name: "prodigi_get_product",
      arguments: { sku: "GLOBAL-CAN-10X10" },
    });
    const output = text(result);
    assert.match(output, /GLOBAL-CAN-10X10/);
    assert.match(output, /ImageWrap/);
    assert.match(output, /1522x1522px/);
    assert.match(calls[0].url, /\/products\/GLOBAL-CAN-10X10$/);
    await client.close();
  });

  it("totals quote item and shipping cost", async () => {
    const { client, calls } = await connect([{ body: QUOTE_RESPONSE }]);
    const result = await client.callTool({
      name: "prodigi_create_quote",
      arguments: {
        destinationCountryCode: "GB",
        items: [
          {
            sku: "GLOBAL-CAN-10X10",
            copies: 1,
            assets: [{ printArea: "default" }],
          },
        ],
      },
    });
    const output = text(result);
    assert.match(output, /\*\*Total:\*\* 9\.00 GBP/);
    assert.match(output, /royalmail/);
    assert.match(calls[0].url, /\/quotes$/);
    assert.equal(calls[0].init.method, "POST");
    await client.close();
  });

  it("reports when a quote returns no options", async () => {
    const { client } = await connect([{ body: { outcome: "Created", quotes: [] } }]);
    const result = await client.callTool({
      name: "prodigi_create_quote",
      arguments: {
        destinationCountryCode: "AQ",
        items: [
          { sku: "BAD-SKU", copies: 1, assets: [{ printArea: "default" }] },
        ],
      },
    });
    assert.equal(result.isError, true);
    assert.match(text(result), /No quotes were returned/);
    await client.close();
  });

  it("creates an order and summarises the result", async () => {
    const { client, calls } = await connect([{ body: ORDER_RESPONSE }]);
    const result = await client.callTool({
      name: "prodigi_create_order",
      arguments: {
        recipient: {
          name: "Mr Test",
          email: "test@example.com",
          address: {
            line1: "14 test place",
            postalOrZipCode: "12345",
            countryCode: "US",
            townOrCity: "somewhere",
          },
        },
        shippingMethod: "Budget",
        idempotencyKey: "guid-1234",
        items: [
          {
            sku: "GLOBAL-CAN-10X10",
            copies: 1,
            sizing: "fillPrintArea",
            assets: [
              {
                printArea: "default",
                url: "https://example.com/image.png",
              },
            ],
          },
        ],
      },
    });
    const output = text(result);
    assert.match(output, /Order created and submitted to fulfilment/);
    assert.match(output, /ord_840797/);
    assert.match(output, /MY-REF-1/);

    const sent = JSON.parse(calls[0].init.body);
    assert.equal(sent.idempotencyKey, "guid-1234");
    assert.equal(sent.items[0].sizing, "fillPrintArea");
    assert.equal(sent.items[0].assets[0].printArea, "default");
    await client.close();
  });

  it("defaults sizing and printArea when omitted", async () => {
    const { client, calls } = await connect([{ body: ORDER_RESPONSE }]);
    await client.callTool({
      name: "prodigi_create_order",
      arguments: {
        recipient: {
          name: "Mr Test",
          address: {
            line1: "14 test place",
            postalOrZipCode: "12345",
            countryCode: "US",
            townOrCity: "somewhere",
          },
        },
        shippingMethod: "Budget",
        items: [
          {
            sku: "GLOBAL-CAN-10X10",
            copies: 1,
            assets: [{ url: "https://example.com/image.png" }],
          },
        ],
      },
    });
    const sent = JSON.parse(calls[0].init.body);
    assert.equal(sent.items[0].sizing, "fillPrintArea");
    assert.equal(sent.items[0].assets[0].printArea, "default");
    await client.close();
  });

  it("warns when an order is created with issues", async () => {
    const body = structuredClone(ORDER_RESPONSE);
    body.outcome = "CreatedWithIssues";
    body.order.status.issues = [
      {
        objectId: "ori_926887",
        errorCode: "order.items.assets.NotDownloaded",
        description: "Download attempt 1 of 10 failed",
      },
    ];
    const { client } = await connect([{ body }]);
    const result = await client.callTool({
      name: "prodigi_create_order",
      arguments: {
        recipient: {
          name: "Mr Test",
          address: {
            line1: "14 test place",
            postalOrZipCode: "12345",
            countryCode: "US",
            townOrCity: "somewhere",
          },
        },
        shippingMethod: "Budget",
        items: [
          {
            sku: "GLOBAL-CAN-10X10",
            copies: 1,
            assets: [{ url: "https://example.com/i.png" }],
          },
        ],
      },
    });
    const output = text(result);
    assert.match(output, /Issues needing attention/);
    assert.match(output, /NotDownloaded/);
    await client.close();
  });

  it("reports per-shipment results when a change is partial", async () => {
    const { client } = await connect([
      {
        body: {
          outcome: "partiallyUpdated",
          order: ORDER_RESPONSE.order,
          shipmentUpdateResults: [
            { shipmentId: "shp_1", successful: true },
            {
              shipmentId: "shp_2",
              successful: false,
              errorCode: "order.shipments.notAvailable",
            },
          ],
        },
      },
    ]);
    const result = await client.callTool({
      name: "prodigi_update_shipping_method",
      arguments: { prodigiOrderId: "ord_840797", shippingMethod: "Express" },
    });
    const output = text(result);
    assert.match(output, /shp_1.*updated/s);
    assert.match(output, /shp_2.*NOT updated/s);
    assert.match(output, /partiallyUpdated/);
    await client.close();
  });

  it("surfaces API errors with the trace id", async () => {
    const { client } = await connect([
      {
        status: 404,
        body: {
          statusText: "Order not found",
          statusCode: 404,
          traceParent: "00-trace-01",
        },
      },
    ]);
    const result = await client.callTool({
      name: "prodigi_get_order",
      arguments: { prodigiOrderId: "ord_missing" },
    });
    assert.equal(result.isError, true);
    const output = text(result);
    assert.match(output, /prodigi_get_order failed/);
    assert.match(output, /Order not found/);
    assert.match(output, /00-trace-01/);
    await client.close();
  });

  it("masks the API key when reporting configuration", async () => {
    const { client } = await connect([]);
    const result = await client.callTool({
      name: "prodigi_get_configuration",
      arguments: {},
    });
    const output = text(result);
    assert.match(output, /sandbox/);
    assert.doesNotMatch(output, /test-key/);
    await client.close();
  });

  it("paginates list_orders using nextUrl", async () => {
    const { client, calls } = await connect([
      {
        body: {
          outcome: "Ok",
          orders: [ORDER_RESPONSE.order, { ...ORDER_RESPONSE.order, id: "ord_2" }],
          hasMore: true,
          nextUrl: "https://api.sandbox.prodigi.com/v4.0/Orders?Skip=2",
        },
      },
      {
        body: {
          outcome: "Ok",
          orders: [{ ...ORDER_RESPONSE.order, id: "ord_3" }],
          hasMore: false,
        },
      },
    ]);
    const result = await client.callTool({
      name: "prodigi_list_orders",
      arguments: { maxItems: 10, status: "inProgress" },
    });
    const output = text(result);
    assert.match(output, /Found 3 order\(s\)/);
    assert.match(output, /ord_840797/);
    assert.match(calls[0].url, /status=inProgress/);
    assert.equal(calls.length, 2);
    await client.close();
  });
});