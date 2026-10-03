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
      "prodigi_create_quote",
      "prodigi_get_configuration",
      "prodigi_get_order",
      "prodigi_get_product",
      "prodigi_get_spine_info",
      "prodigi_list_orders",
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

  it("exposes no tool that writes, and marks every tool read-only", async () => {
    const { client } = await connect([]);
    const { tools } = await client.listTools();

    for (const tool of tools) {
      assert.equal(
        tool.annotations?.destructiveHint,
        undefined,
        `${tool.name} must not be advertised as destructive; it should not exist`,
      );
      assert.equal(
        tool.annotations?.readOnlyHint,
        true,
        `${tool.name} must declare itself read-only`,
      );
    }

    // Guard against a write tool being reintroduced under a new name.
    for (const tool of tools) {
      assert.doesNotMatch(
        tool.name,
        /create_order|cancel|update_|delete|remove|submit|refund/,
        `${tool.name} looks like a mutating tool`,
      );
    }
    await client.close();
  });

  it("rejects calls to tools that are not registered", async () => {
    const { client } = await connect([]);
    for (const name of [
      "prodigi_create_order",
      "prodigi_cancel_order",
      "prodigi_update_recipient",
      "prodigi_update_shipping_method",
      "prodigi_update_order_metadata",
      "prodigi_get_order_actions",
    ]) {
      const result = await client.callTool({ name, arguments: {} });
      assert.equal(result.isError, true, `${name} must not be callable`);
    }
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