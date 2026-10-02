import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ProdigiApiError, safeStringify } from "../prodigi/client.js";

/**
 * Registers a tool with automatic, model-readable error handling.
 *
 * This matters for Prodigi specifically: a failed request often carries an
 * order object whose `status.issues` explains exactly what went wrong - an
 * asset that will not download, a SKU that is unavailable, a payment
 * authorisation URL. Left unhandled the SDK reports only "Error: something
 * went wrong", those details never reach the model, and it cannot tell the
 * user what to fix.
 */
export function registerTool(
  server: McpServer,
  name: string,
  config: ToolConfig,
  handler: ToolHandler,
): unknown {
  return (
    server.registerTool as unknown as (
      name: string,
      config: unknown,
      handler: unknown,
    ) => unknown
  )(name, config, withErrorHandling(name, handler));
}

/**
 * Mirrors the SDK's `registerTool` config. `inputSchema` is intentionally
 * untyped here: per-tool argument shapes are defined with Zod in the tool
 * modules and validated by the SDK at call time, so this wrapper adds no extra
 * guarantee that a precisely typed schema would.
 */
export interface ToolConfig {
  title?: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: Record<string, unknown>;
}

/** See `ToolConfig` for why the handler is loosely typed. */
export type ToolHandler = (
  args: any,
  extra: { signal?: AbortSignal },
) => Promise<unknown>;

/**
 * Wraps a tool handler so failures surface as descriptive MCP errors rather
 * than opaque protocol rejections. Cancellations pass through untouched so a
 * client-initiated abort stays distinguishable from a genuine failure.
 */
export function withErrorHandling<A extends unknown[], R>(
  toolName: string,
  handler: (...args: A) => Promise<R>,
): (...args: A) => Promise<R> {
  return async (...args: A): Promise<R> => {
    try {
      return await handler(...args);
    } catch (err) {
      if (isAbortError(err)) throw err;

      if (err instanceof ProdigiApiError) {
        const error = new Error(
          `${toolName} failed. ${buildDetail(err)}`,
        ) as Error & { code?: string; data?: unknown };
        error.code = `PRODIGI_${err.statusCode || "NETWORK"}`;
        error.data = err.data;
        throw error;
      }

      throw err;
    }
  };
}

function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "AbortError" || /\babort(ed)?\b/i.test(err.message))
  );
}

function buildDetail(err: ProdigiApiError): string {
  const parts = [err.message];
  if (err.outcome) parts.push(`Outcome: ${err.outcome}.`);
  if (err.traceParent) {
    parts.push(
      `Prodigi trace id: ${err.traceParent} - include it if you contact ` +
        `support@prodigi.com.`,
    );
  }
  if (err.data !== undefined && err.data !== null) {
    parts.push(`Details: ${safeStringify(err.data)}`);
  }
  if (/timed out/i.test(err.message)) {
    parts.push(
      "The Prodigi API aborts requests after 60 seconds, so a retry may succeed.",
    );
  }
  return parts.join(" ");
}