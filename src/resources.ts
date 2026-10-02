import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ProdigiApi } from "./prodigi/api.js";
import type { ProdigiConfig } from "./prodigi/config.js";
import { WORKFLOW_GUIDANCE } from "./docs.js";

export { WORKFLOW_GUIDANCE };

/**
 * Resources expose reference material a model can read on demand, which is
 * cheaper than repeating everything in tool descriptions.
 */
export function registerResources(
  server: McpServer,
  api: ProdigiApi,
  config: ProdigiConfig,
): void {
  server.registerResource(
    "prodigi-workflow-guide",
    "prodigi://guide/workflow",
    {
      title: "Prodigi ordering workflow guide",
      description:
        "How to use these tools correctly: the get_product → create_quote → " +
        "create_order sequence, hard requirements on asset URLs and country " +
        "codes, the order lifecycle and when actions become unavailable, and " +
        "idempotency guidance.",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/markdown", text: WORKFLOW_GUIDANCE }],
    }),
  );

  server.registerResource(
    "prodigi-sku",
    new ResourceTemplate("prodigi://product/{sku}", { list: undefined }),
    {
      title: "Prodigi product definition",
      description:
        "Full definition of a single SKU, including valid attribute values, " +
        "required print areas, recommended image resolutions and shipping " +
        "destinations.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const sku = String(variables.sku ?? "");
      const { product } = await api.getProduct(sku);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(product, null, 2),
          },
        ],
      };
    },
  );

  server.registerResource(
    "prodigi-order",
    new ResourceTemplate("prodigi://order/{orderId}", { list: undefined }),
    {
      title: "Prodigi order",
      description:
        "The full order object for a Prodigi order ID, as returned by the API.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const orderId = String(variables.orderId ?? "");
      const { order } = await api.getOrder(orderId);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(order, null, 2),
          },
        ],
      };
    },
  );

  server.registerResource(
    "prodigi-environment",
    "prodigi://config/environment",
    {
      title: "Connection environment",
      description:
        "Which Prodigi environment this server targets (sandbox or live) and " +
        "the base URL in use. The API key itself is never exposed.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(
            { environment: config.environment, baseUrl: config.baseUrl },
            null,
            2,
          ),
        },
      ],
    }),
  );
}
