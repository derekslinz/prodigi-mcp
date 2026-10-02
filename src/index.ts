#!/usr/bin/env node
/**
 * Entry point for the Prodigi MCP server.
 *
 * Communicates over stdio, so all diagnostics go to stderr - writing to stdout
 * would corrupt the JSON-RPC stream.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ConfigurationError, loadConfig } from "./prodigi/config.js";
import { createProdigiServer, SERVER_NAME, SERVER_VERSION } from "./server.js";

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigurationError) {
      console.error(`${SERVER_NAME}: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  const server = createProdigiServer(config);
  const transport = new StdioServerTransport();

  const shutdown = async (signal: string) => {
    console.error(`${SERVER_NAME}: received ${signal}, shutting down`);
    await server.close().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await server.connect(transport);
  console.error(
    `${SERVER_NAME} v${SERVER_VERSION} connected to Prodigi ` +
      `(${config.environment} @ ${config.baseUrl})`,
  );
}

main().catch((err) => {
  console.error(`${SERVER_NAME}: fatal error:`, err);
  process.exit(1);
});