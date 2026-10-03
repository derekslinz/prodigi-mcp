import type { ProdigiEnvironment } from "./types.js";

export interface ProdigiConfig {
  /** The X-API-Key sent with every request. */
  apiKey: string;
  /** Base URL without a trailing slash, e.g. https://api.prodigi.com/v4.0 */
  baseUrl: string;
  environment: ProdigiEnvironment;
  /** Per-request timeout in milliseconds. */
  timeoutMs: number;
}

export const SANDBOX_BASE_URL = "https://api.sandbox.prodigi.com/v4.0";
export const LIVE_BASE_URL = "https://api.prodigi.com/v4.0";

export const DEFAULT_TIMEOUT_MS = 60_000;

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

/**
 * Resolves configuration from the environment.
 *
 * `PRODIGI_ENVIRONMENT` accepts `sandbox` or `live` (case-insensitive). When it
 * is absent but a key is present we default to sandbox, since hitting the live
 * API by accident is the far more expensive mistake.
 */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
): ProdigiConfig {
  const apiKey = env.PRODIGI_API_KEY?.trim();
  if (!apiKey) {
    throw new ConfigurationError(
      "PRODIGI_API_KEY is not set. Create a key at https://dashboard.prodigi.com/ " +
        "and export it before starting the server.",
    );
  }

  const rawEnv = (env.PRODIGI_ENVIRONMENT ?? "sandbox").trim().toLowerCase();
  let environment: ProdigiEnvironment;
  switch (rawEnv) {
    case "sandbox":
      environment = "sandbox";
      break;
    case "live":
    case "production":
      environment = "live";
      break;
    default:
      throw new ConfigurationError(
        `PRODIGI_ENVIRONMENT must be "sandbox" or "live", received "${rawEnv}".`,
      );
  }

  const timeoutRaw = env.PRODIGI_TIMEOUT_MS?.trim();
  const timeoutMs = timeoutRaw ? Number.parseInt(timeoutRaw, 10) : DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new ConfigurationError(
      `PRODIGI_TIMEOUT_MS must be a positive integer, received "${timeoutRaw}".`,
    );
  }

  return {
    apiKey,
    environment,
    baseUrl:
      environment === "live" ? LIVE_BASE_URL : SANDBOX_BASE_URL,
    timeoutMs,
  };
}

/** Redacts secrets so configuration can be safely surfaced in tool output. */
export function describeConfig(config: ProdigiConfig): string {
  const masked =
    config.apiKey.length <= 4
      ? "****"
      : `${config.apiKey.slice(0, 2)}${"*".repeat(Math.max(4, config.apiKey.length - 6))}${config.apiKey.slice(-4)}`;
  return [
    `environment: ${config.environment}`,
    `baseUrl:    ${config.baseUrl}`,
    `apiKey:     ${masked}`,
    `timeoutMs:  ${config.timeoutMs}`,
    `mode:       READ-ONLY (cannot place, change or cancel orders)`,
  ].join("\n");
}
