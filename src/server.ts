import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ProdigiApi } from "./prodigi/api.js";
import { describeConfig, type ProdigiConfig } from "./prodigi/config.js";
import { ProdigiClient } from "./prodigi/client.js";
import { ProdigiApi as Api } from "./prodigi/api.js";
import { registerOrderReadTools } from "./tools/orders.js";
import { registerProductTools } from "./tools/products.js";
import { registerTool } from "./tools/error-handler.js";
import { registerQuoteTools } from "./tools/quotes.js";
import { WORKFLOW_GUIDANCE, registerResources } from "./resources.js";

export { WORKFLOW_GUIDANCE };

export const SERVER_NAME = "prodigi-mcp";
export const SERVER_VERSION = "0.1.0";

export interface CreateServerResult {
  server: McpServer;
  api: ProdigiApi;
}

/**
 * Builds the fully wired MCP server. Kept separate from process startup so
 * tests can drive it over an in-memory transport.
 */
export function createProdigiServer(
  config: ProdigiConfig,
  fetchImpl?: typeof fetch,
): McpServer {
  const client = new ProdigiClient({ config, fetchImpl });
  const api = new Api(client);

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        `Read-only access to the Prodigi Print API v4 (${config.environment} ` +
        `environment). You can look up products, price a basket with ` +
        `prodigi_create_quote, and inspect existing orders, but you cannot ` +
        `place, modify or cancel them - no such tool is exposed. To take an ` +
        `order, hand the basket and customer details to the user, or to ` +
        `another system that can submit it.`,
    },
  );

  registerProductTools(server, api);
  registerQuoteTools(server, api);
  registerOrderReadTools(server, api);

  registerResources(server, api, config);

  registerTool(
    server,
    "prodigi_get_configuration",
    {
      title: "Show server configuration",
      description:
        "Report which Prodigi environment this server is connected to and the " +
        "API key in use (masked). Use this to confirm whether orders will hit " +
        "sandbox or live before doing anything irreversible.",
      annotations: { readOnlyHint: true },
      inputSchema: {},
    },
    async () => ({
      content: [
        {
          type: "text" as const,
          text:
            `Prodigi API connection\n\n${describeConfig(config)}\n\n` +
            (config.environment === "sandbox"
              ? "This is the SANDBOX environment. Orders are not fulfilled and " +
                "nothing is charged, but orders are also not real."
              : "This is the LIVE environment. Orders placed here are produced, " +
                "shipped and billed.") +
            `\n\nThis server is read-only: no tool here can place, change or ` +
            `cancel an order.`,
        },
      ],
    }),
  );

  return server;
}
