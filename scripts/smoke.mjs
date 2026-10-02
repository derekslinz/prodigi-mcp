#!/usr/bin/env node
/**
 * Manual smoke test: boots the real stdio server as a child process and
 * exercises an MCP handshake plus tools/list, resources/list and a tool call.
 *
 *   PRODIGI_API_KEY=dummy node scripts/smoke.mjs
 *
 * A dummy key is used by default and no live API calls are made.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, "..", "dist", "index.js");

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [entry],
  env: {
    ...process.env,
    PRODIGI_API_KEY: process.env.PRODIGI_API_KEY ?? "dummy",
  },
  stderr: "inherit",
});

const client = new Client({ name: "smoke", version: "1.0.0" });
await client.connect(transport);

console.log("server:", client.getServerVersion());
console.log("instructions:", (client.getInstructions() ?? "").slice(0, 90) + "...");

const { tools } = await client.listTools();
console.log(`\ntools (${tools.length}):`);
for (const t of tools) console.log(`  - ${t.name}`);

const { resources } = await client.listResources();
console.log(`\nresources (${resources.length}):`);
for (const r of resources) console.log(`  - ${r.uri}`);

const { resourceTemplates } = await client.listResourceTemplates();
console.log(`\ntemplates (${resourceTemplates.length}):`);
for (const t of resourceTemplates) console.log(`  - ${t.uriTemplate}`);

const guide = await client.readResource({ uri: "prodigi://guide/workflow" });
console.log(`\nguide length: ${guide.contents[0].text.length} chars`);

const cfg = await client.callTool({
  name: "prodigi_get_configuration",
  arguments: {},
});
console.log("\nconfiguration tool:");
console.log(cfg.content[0].text);

await client.close();
console.log("\nsmoke test OK");