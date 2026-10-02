import type { ProdigiConfig } from "./config.js";
import type { ErrorBody, Order } from "./types.js";

/**
 * An error returned by the Prodigi API, normalised into something an LLM can
 * act on. Carries the HTTP status, Prodigi's human-readable `statusText`, and
 * the `traceParent` correlation id that Prodigi support asks for.
 */
export class ProdigiApiError extends Error {
  readonly statusCode: number;
  readonly outcome: string | undefined;
  readonly traceParent: string | undefined;
  readonly data: unknown;

  constructor(params: {
    message: string;
    statusCode: number;
    outcome?: string;
    traceParent?: string;
    data?: unknown;
  }) {
    super(params.message);
    this.name = "ProdigiApiError";
    this.statusCode = params.statusCode;
    this.outcome = params.outcome;
    this.traceParent = params.traceParent;
    this.data = params.data;
  }

  /** Renders a message suitable for a tool result, including support context. */
  toToolMessage(): string {
    const parts = [`Prodigi API error ${this.statusCode}: ${this.message}`];
    if (this.outcome) parts.push(`outcome: ${this.outcome}`);
    if (this.traceParent) {
      parts.push(
        `traceParent: ${this.traceParent} (include this when contacting support@prodigi.com)`,
      );
    }
    if (this.data !== undefined && this.data !== null) {
      parts.push(`data: ${safeStringify(this.data)}`);
    }
    return parts.join("\n");
  }
}

export function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

export interface RequestOptions {
  method?: "GET" | "POST";
  /** Query parameters. Arrays are repeated (`?a=1&a=2`), as Prodigi expects. */
  query?: Record<string, string | number | boolean | string[] | undefined>;
  body?: unknown;
  signal?: AbortSignal;
}

interface ProdigiClientOptions {
  config: ProdigiConfig;
  /** Injectable for tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Thin, dependency-free wrapper over the Prodigi Print API v4.
 *
 * Responsibilities:
 * - attach the `X-API-Key` header and `Content-Type: application/json`
 * - enforce a request timeout (the API itself aborts at 60s)
 * - translate non-2xx responses and non-`Ok`-ish outcomes into `ProdigiApiError`
 * - follow `nextUrl` pagination for list endpoints
 */
export class ProdigiClient {
  private readonly config: ProdigiConfig;
  private readonly fetchImpl: typeof fetch;

  constructor({ config, fetchImpl }: ProdigiClientOptions) {
    this.config = config;
    this.fetchImpl = fetchImpl ?? ((...args) => fetch(...args));
  }

  get environment(): ProdigiConfig["environment"] {
    return this.config.environment;
  }

  get baseUrl(): string {
    return this.config.baseUrl;
  }

  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const { method = "GET", query, body, signal } = options;
    const url = this.buildUrl(path, query);

    const headers: Record<string, string> = {
      "X-API-Key": this.config.apiKey,
      Accept: "application/json",
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";

    const timeoutController = new AbortController();
    const timeout = setTimeout(() => timeoutController.abort(), this.config.timeoutMs);
    // Honour an externally supplied signal alongside our own timeout.
    const onExternalAbort = () => timeoutController.abort();
    signal?.addEventListener("abort", onExternalAbort, { once: true });

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: timeoutController.signal,
      });
    } catch (err) {
      if (timeoutController.signal.aborted) {
        throw new ProdigiApiError({
          message: `Request to ${method} ${url} timed out after ${this.config.timeoutMs}ms.`,
          statusCode: 504,
        });
      }
      throw new ProdigiApiError({
        message: `Network error calling ${method} ${url}: ${
          err instanceof Error ? err.message : String(err)
        }`,
        statusCode: 0,
      });
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onExternalAbort);
    }

    const text = await response.text();
    const traceParent = response.headers.get("traceparent") ?? undefined;
    let parsed: unknown;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
    }

    if (!response.ok) {
      const errBody = (parsed ?? {}) as ErrorBody & {
        outcome?: string;
        failures?: unknown;
        issues?: unknown;
      };
      const outcome = typeof errBody.outcome === "string" ? errBody.outcome : undefined;

      // Prodigi uses two different error envelopes. A 4xx/5xx usually carries
      // the documented `{statusText, statusCode, data}` shape, but some
      // endpoints - notably a failed quote validation - answer with the same
      // `{outcome, failures}` body used for HTTP 200 failures. When that
      // happens the `statusText` fallback would report only "Bad Request" and
      // silently discard the field-level detail that tells the caller what is
      // actually wrong, so prefer the outcome-derived message.
      const message =
        (outcome && isFailureOutcome(outcome)
          ? describeFailureOutcome(outcome, parsed)
          : undefined) ??
        errBody.statusText ??
        (typeof parsed === "string" && parsed.length > 0
          ? parsed
          : response.statusText || "Request failed");

      throw new ProdigiApiError({
        message,
        statusCode: errBody.statusCode ?? response.status,
        outcome,
        traceParent: errBody.traceParent ?? traceParent,
        data: errBody.data ?? errBody.failures,
      });
    }

    // A 2xx can still carry a failure outcome (e.g. failedToCancel).
    if (parsed && typeof parsed === "object" && "outcome" in parsed) {
      const outcome = String((parsed as { outcome: unknown }).outcome);
      if (isFailureOutcome(outcome)) {
        throw new ProdigiApiError({
          message: describeFailureOutcome(outcome, parsed),
          statusCode: response.status,
          outcome,
          traceParent:
            (parsed as { traceParent?: string }).traceParent ?? traceParent,
        });
      }
    }

    return parsed as T;
  }

  private buildUrl(
    path: string,
    query?: RequestOptions["query"],
  ): string {
    const normalisedPath = path.startsWith("/") ? path : `/${path}`;
    const base = `${this.config.baseUrl}${normalisedPath}`;
    if (!query) return base;
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        for (const item of value) params.append(key, item);
      } else {
        params.append(key, String(value));
      }
    }
    const qs = params.toString();
    return qs ? `${base}?${qs}` : base;
  }

  /**
   * Walks a paginated list endpoint, returning up to `maxItems` records.
   * Uses the server-provided `nextUrl` so cursor semantics are respected.
   *
   * @param path   Endpoint path, used only for the first page.
   * @param key    Property name holding the array of records in the response.
   */
  async paginate<T>(
    path: string,
    key: string,
    maxItems: number,
    query?: RequestOptions["query"],
    signal?: AbortSignal,
  ): Promise<PaginatedResult<T>> {
    const collected: T[] = [];
    let pagesFetched = 0;
    let url: string | null = null;

    while (collected.length < maxItems) {
      const body: Record<string, unknown> = await this.request<Record<string, unknown>>(
        url ?? path,
        url ? { signal } : { query, signal },
      );
      pagesFetched += 1;

      const page = (Array.isArray(body[key]) ? body[key] : []) as T[];
      collected.push(...page);

      const hasMore = body.hasMore === true && typeof body.nextUrl === "string";
      const nextUrl = hasMore ? (body.nextUrl as string) : null;
      url = nextUrl;

      if (!url) {
        return {
          items: collected.slice(0, maxItems),
          hasMore: false,
          nextUrl: null,
          pagesFetched,
        };
      }
    }

    return {
      items: collected.slice(0, maxItems),
      hasMore: true,
      nextUrl: url,
      pagesFetched,
    };
  }
}

export interface PaginatedResult<T> {
  items: T[];
  /** True when the server has more pages beyond what was collected. */
  hasMore: boolean;
  /** Cursor URL for the next page, or null when exhausted. */
  nextUrl: string | null;
  pagesFetched: number;
}

/* -------------------------------------------------------------------------- */
/* Outcome handling                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Outcomes that indicate the request itself succeeded but the operation did
 * not do what the caller asked for. The API returns these with HTTP 200.
 *
 * Casing matters here: the published reference documents these in lower camel
 * case, but the live API returns them PascalCased (`ValidationFailed`,
 * `EntityNotFound`). Both spellings are listed so a mismatch can never cause a
 * failure to be silently treated as success. Comparisons are also made
 * case-insensitively in `isFailureOutcome`.
 */
const FAILURE_OUTCOMES = new Set([
  "validationFailed",
  "ValidationFailed",
  "entityNotFound",
  "EntityNotFound",
  "endpointDoesNotExist",
  "EndpointDoesNotExist",
  "methodNotAllowed",
  "MethodNotAllowed",
  "invalidContentType",
  "InvalidContentType",
  "internalServerError",
  "InternalServerError",
  "timedOut",
  "TimedOut",
  "failedToCancel",
  "FailedToCancel",
  "failedToUpdate",
  "FailedToUpdate",
  "actionNotAvailable",
  "ActionNotAvailable",
]);

/**
 * Outcomes that mean the request partially or fully succeeded but the caller
 * should be made aware of caveats. These are surfaced as warnings alongside the
 * result rather than raised as errors, because throwing would discard the
 * order/quote object that the caller needs in order to act.
 */
const WARNING_OUTCOMES = new Set([
  "partiallyUpdated",
  "PartiallyUpdated",
  "createdWithIssues",
  "CreatedWithIssues",
]);

function isFailureOutcome(outcome: string): boolean {
  return FAILURE_OUTCOMES.has(outcome);
}

/** Lower-cases the first character so documented and actual spellings unify. */
function canonicalOutcome(outcome: string): string {
  return outcome.charAt(0).toLowerCase() + outcome.slice(1);
}

/**
 * Pulls the human-readable detail out of whatever error shape the endpoint
 * used. Prodigi is inconsistent here: some failures carry
 * `order.status.issues`, others a top-level `issues` array, and
 * `ValidationFailed` on quotes carries a `failures` map keyed by field path.
 */
function extractIssueText(body: unknown): string {
  const envelope = body as {
    order?: { status?: { issues?: { errorCode: string; description: string }[] } };
    issues?: { errorCode: string; description: string }[];
    failures?: unknown;
  };

  const issues =
    envelope?.order?.status?.issues ??
    (Array.isArray(envelope?.issues) ? envelope.issues : []);
  const parts: string[] = [];
  if (issues.length > 0) {
    parts.push(
      issues
        .map((i) => `${i.errorCode}: ${i.description}`)
        .join("; "),
    );
  }

  const failures = envelope?.failures;
  if (failures && typeof failures === "object") {
    for (const [field, detail] of Object.entries(failures as Record<string, unknown>)) {
      parts.push(`${field}: ${renderFailureDetail(detail)}`);
    }
  }

  return parts.length > 0 ? ` Issues: ${parts.join("; ")}` : "";
}

function renderFailureDetail(detail: unknown): string {
  if (detail === null || typeof detail !== "object") return String(detail);
  type FailureEntry = {
    code?: string;
    missingItems?: unknown;
    providedValue?: unknown;
    comparisonValue?: unknown;
  };
  const entries: FailureEntry[] = Array.isArray(detail)
    ? (detail as FailureEntry[])
    : [detail as FailureEntry];
  return entries
    .map((d) => {
      const bits: string[] = [];
      if (d.code) bits.push(d.code);
      const missing = (
        d.missingItems as
          | { attributes?: { name: string; validValues?: string[] }[] }
          | undefined
      )?.attributes;
      if (missing?.length) {
        bits.push(
          `missing required attribute(s): ${missing
            .map((a) => `${a.name} (valid: ${(a.validValues ?? []).join(", ")})`)
            .join("; ")}`,
        );
      }
      // `comparisonValue` is often the actionable half of the pair: a rejected
      // destination change reports the country the order is already booked to,
      // which is the fact the caller actually needs.
      if (d.comparisonValue !== undefined && d.comparisonValue !== null) {
        bits.push(`cannot change from ${JSON.stringify(d.comparisonValue)}`);
      }
      if (d.providedValue !== undefined) {
        bits.push(`received ${JSON.stringify(d.providedValue)}`);
      }
      return bits.join(" ");
    })
    .join("; ");
}

function describeFailureOutcome(outcome: string, body: unknown): string {
  const issueText = extractIssueText(body);

  switch (canonicalOutcome(outcome)) {
    case "validationFailed":
      return `The request failed validation. Check required fields, SKU names, ` +
        `country codes and asset URLs.${issueText}`;
    case "entityNotFound":
      return `The requested entity was not found. It may not exist, or it may not ` +
        `be visible to this API key.${issueText}`;
    case "endpointDoesNotExist":
      return "The API does not recognise this endpoint.";
    case "methodNotAllowed":
      return "The HTTP method is not supported by this endpoint.";
    case "invalidContentType":
      return "Unsupported content type. Prodigi only accepts application/json.";
    case "internalServerError":
    case "timedOut":
      return `Prodigi could not process the request in time (${outcome}). Please retry shortly.${issueText}`;
    case "failedToCancel":
      return `The order could not be cancelled - it is likely already in production.${issueText}`;
    case "failedToUpdate":
      return `No shipments could be updated, so nothing was changed.${issueText}`;
    case "partiallyUpdated":
      return `The change was applied to the order but at least one shipment could not be updated.${issueText}`;
    case "actionNotAvailable":
      return "This action is no longer available - the order has progressed past the point where it can be changed.";
    default:
      return `The request completed with outcome "${outcome}".${issueText}`;
  }
}

export { isFailureOutcome, describeFailureOutcome, WARNING_OUTCOMES };
