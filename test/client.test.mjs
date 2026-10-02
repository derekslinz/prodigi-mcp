import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ConfigurationError,
  ProdigiApiError,
  ProdigiClient,
  loadConfig,
} from "../dist/prodigi/index.js";

const CONFIG = {
  apiKey: "test-key",
  environment: "sandbox",
  baseUrl: "https://api.sandbox.prodigi.com/v4.0",
  timeoutMs: 1000,
};

/** Builds a fetch stub that records calls and replays queued responses. */
function stubFetch(responses) {
  const calls = [];
  let index = 0;
  const impl = async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    const spec = responses[Math.min(index++, responses.length - 1)];
    const status = spec.status ?? 200;
    return new Response(
      spec.body === undefined ? "" : JSON.stringify(spec.body),
      {
        status,
        headers: { "Content-Type": "application/json", ...spec.headers },
      },
    );
  };
  return { impl, calls };
}

describe("loadConfig", () => {
  it("defaults to the sandbox environment", () => {
    const config = loadConfig({ PRODIGI_API_KEY: "abc" });
    assert.equal(config.environment, "sandbox");
    assert.equal(config.baseUrl, "https://api.sandbox.prodigi.com/v4.0");
  });

  it("switches to the live base URL", () => {
    const config = loadConfig({
      PRODIGI_API_KEY: "abc",
      PRODIGI_ENVIRONMENT: "LIVE",
    });
    assert.equal(config.environment, "live");
    assert.equal(config.baseUrl, "https://api.prodigi.com/v4.0");
  });

  it("requires an API key", () => {
    assert.throws(() => loadConfig({}), ConfigurationError);
  });

  it("rejects an unknown environment", () => {
    assert.throws(
      () =>
        loadConfig({
          PRODIGI_API_KEY: "abc",
          PRODIGI_ENVIRONMENT: "staging",
        }),
      ConfigurationError,
    );
  });

  it("rejects a non-positive timeout", () => {
    assert.throws(
      () =>
        loadConfig({
          PRODIGI_API_KEY: "abc",
          PRODIGI_TIMEOUT_MS: "0",
        }),
      ConfigurationError,
    );
  });
});

describe("ProdigiClient", () => {
  it("sends the API key and JSON content type", async () => {
    const { impl, calls } = stubFetch([{ body: { outcome: "Ok" } }]);
    const client = new ProdigiClient({ config: CONFIG, fetchImpl: impl });
    await client.request("/orders", { method: "POST", body: { a: 1 } });

    const headers = calls[0].init.headers;
    assert.equal(headers["X-API-Key"], "test-key");
    assert.equal(headers["Content-Type"], "application/json");
    assert.equal(calls[0].init.body, JSON.stringify({ a: 1 }));
  });

  it("omits the content type on GET requests", async () => {
    const { impl, calls } = stubFetch([{ body: { outcome: "Ok" } }]);
    const client = new ProdigiClient({ config: CONFIG, fetchImpl: impl });
    await client.request("/orders");
    const headers = calls[0].init.headers;
    assert.equal(headers["Content-Type"], undefined);
  });

  it("repeats array query parameters", async () => {
    const { impl, calls } = stubFetch([{ body: { outcome: "Ok" } }]);
    const client = new ProdigiClient({ config: CONFIG, fetchImpl: impl });
    await client.request("/orders", {
      query: { orderIds: ["ord_1", "ord_2"], top: 5, skip: undefined },
    });
    assert.match(calls[0].url, /orderIds=ord_1&orderIds=ord_2/);
    assert.match(calls[0].url, /top=5/);
    assert.doesNotMatch(calls[0].url, /skip=/);
  });

  it("maps a 404 body onto ProdigiApiError with traceParent", async () => {
    const { impl } = stubFetch([
      {
        status: 404,
        body: {
          statusText: "Order not found",
          statusCode: 404,
          traceParent: "00-abc-def-00",
        },
      },
    ]);
    const client = new ProdigiClient({ config: CONFIG, fetchImpl: impl });
    await assert.rejects(
      () => client.request("/orders/ord_missing"),
      (err) => {
        assert.ok(err instanceof ProdigiApiError);
        assert.equal(err.statusCode, 404);
        assert.equal(err.message, "Order not found");
        assert.equal(err.traceParent, "00-abc-def-00");
        assert.match(err.toToolMessage(), /support@prodigi\.com/);
        return true;
      },
    );
  });

  it("treats entityNotFound returned with HTTP 200 as an error", async () => {
    const { impl } = stubFetch([
      { status: 200, body: { outcome: "entityNotFound" } },
    ]);
    const client = new ProdigiClient({ config: CONFIG, fetchImpl: impl });
    await assert.rejects(
      () => client.request("/orders/ord_missing"),
      (err) => {
        assert.ok(err instanceof ProdigiApiError);
        assert.equal(err.outcome, "entityNotFound");
        assert.match(err.message, /could not find|not found/i);
        return true;
      },
    );
  });

  it("includes order issues in validationFailed messages", async () => {
    const { impl } = stubFetch([
      {
        status: 200,
        body: {
          outcome: "validationFailed",
          order: {
            status: {
              issues: [
                {
                  errorCode: "order.items.assets.NotDownloaded",
                  description: "Download attempt 1 of 10 failed",
                },
              ],
            },
          },
        },
      },
    ]);
    const client = new ProdigiClient({ config: CONFIG, fetchImpl: impl });
    await assert.rejects(
      () => client.request("/orders", { method: "POST", body: {} }),
      (err) => {
        assert.ok(err instanceof ProdigiApiError);
        assert.match(err.message, /NotDownloaded/);
        return true;
      },
    );
  });

  it("uses the outcome envelope for HTTP 400 validation failures", async () => {
    // Regression: Prodigi answers a failed quote validation with HTTP 400 but an
    // `{outcome, failures}` body, not the documented `{statusText, data}` shape.
    // Reading statusText alone reported "Bad Request" and dropped the detail.
    const { impl } = stubFetch([
      {
        status: 400,
        body: {
          outcome: "ValidationFailed",
          failures: {
            "items[0].attributes": [
              {
                code: "MissingRequiredAttributes",
                missingItems: {
                  attributes: [{ name: "wrap", validValues: ["Black", "White"] }],
                },
                providedValue: null,
              },
            ],
          },
          traceParent: "00-vf-00",
        },
      },
    ]);
    const client = new ProdigiClient({ config: CONFIG, fetchImpl: impl });
    await assert.rejects(
      () => client.request("/quotes", { method: "POST", body: {} }),
      (err) => {
        assert.ok(err instanceof ProdigiApiError);
        assert.equal(err.statusCode, 400);
        assert.equal(err.outcome, "ValidationFailed");
        assert.match(err.message, /failed validation/);
        assert.match(err.message, /wrap \(valid: Black, White\)/);
        assert.doesNotMatch(err.message, /^Bad Request$/);
        assert.equal(err.traceParent, "00-vf-00");
        return true;
      },
    );
  });

  it("still prefers statusText when no outcome is present", async () => {
    const { impl } = stubFetch([
      {
        status: 400,
        body: { statusText: "Something went wrong", statusCode: 400 },
      },
    ]);
    const client = new ProdigiClient({ config: CONFIG, fetchImpl: impl });
    await assert.rejects(
      () => client.request("/orders", { method: "POST", body: {} }),
      (err) => {
        assert.equal(err.message, "Something went wrong");
        assert.equal(err.outcome, undefined);
        return true;
      },
    );
  });

  it("includes comparisonValue so the caller sees the existing value", async () => {
    // A rejected destination change reports both the attempted country and the
    // one already booked. Without the comparison value the caller cannot tell
    // which is the fixed constraint.
    const { impl } = stubFetch([
      {
        status: 400,
        body: {
          outcome: "ValidationFailed",
          failures: {
            "address.countryCode": [
              {
                code: "ChangeOfDestinationCountryNotPossible",
                comparisonValue: "US",
                providedValue: "GB",
              },
            ],
          },
        },
      },
    ]);
    const client = new ProdigiClient({ config: CONFIG, fetchImpl: impl });
    await assert.rejects(
      () => client.request("/orders/ord_1/actions/updateRecipient", { method: "POST" }),
      (err) => {
        assert.match(err.message, /ChangeOfDestinationCountryNotPossible/);
        assert.match(err.message, /cannot change from "US"/);
        assert.match(err.message, /received "GB"/);
        return true;
      },
    );
  });

  it("treats PascalCase ValidationFailed as an error, not success", async () => {
    // Regression: the published docs spell this `validationFailed` in lower
    // camel case, but the live API returns `ValidationFailed`. Matching only the
    // documented casing silently turned real failures into apparent successes.
    const { impl } = stubFetch([
      {
        status: 200,
        body: {
          outcome: "ValidationFailed",
          failures: {
            "items[0].attributes": [
              {
                code: "MissingRequiredAttributes",
                missingItems: {
                  attributes: [
                    { name: "wrap", validValues: ["White", "ImageWrap", "Black"] },
                  ],
                },
                providedValue: null,
              },
            ],
          },
        },
      },
    ]);
    const client = new ProdigiClient({ config: CONFIG, fetchImpl: impl });
    await assert.rejects(
      () => client.request("/quotes", { method: "POST", body: {} }),
      (err) => {
        assert.ok(err instanceof ProdigiApiError);
        assert.equal(err.outcome, "ValidationFailed");
        assert.match(err.message, /failed validation/);
        assert.match(err.message, /MissingRequiredAttributes/);
        assert.match(err.message, /wrap \(valid: White, ImageWrap, Black\)/);
        return true;
      },
    );
  });

  it("treats PascalCase EntityNotFound as an error", async () => {
    const { impl } = stubFetch([
      { status: 200, body: { outcome: "EntityNotFound" } },
    ]);
    const client = new ProdigiClient({ config: CONFIG, fetchImpl: impl });
    await assert.rejects(
      () => client.request("/orders/ord_000000"),
      (err) => {
        assert.ok(err instanceof ProdigiApiError);
        assert.equal(err.outcome, "EntityNotFound");
        assert.match(err.message, /not be visible to this API key/);
        return true;
      },
    );
  });

  it("surfaces top-level issues as well as order.status.issues", async () => {
    const { impl } = stubFetch([
      {
        status: 200,
        body: {
          outcome: "ValidationFailed",
          issues: [
            {
              objectId: null,
              errorCode: "destinationCountryCode.UsSalesTaxWarning",
              description: "Quote does not include sales tax",
            },
          ],
        },
      },
    ]);
    const client = new ProdigiClient({ config: CONFIG, fetchImpl: impl });
    await assert.rejects(
      () => client.request("/quotes", { method: "POST", body: {} }),
      (err) => {
        assert.match(err.message, /UsSalesTaxWarning/);
        return true;
      },
    );
  });

  it("does not throw on CreatedWithIssues, which carries quotes", async () => {
    const { impl } = stubFetch([
      {
        status: 200,
        body: {
          outcome: "CreatedWithIssues",
          issues: [
            {
              errorCode: "destinationCountryCode.UsSalesTaxWarning",
              description: "Quote does not include sales tax, which may apply",
            },
          ],
          quotes: [{ shipmentMethod: "Budget" }],
        },
      },
    ]);
    const client = new ProdigiClient({ config: CONFIG, fetchImpl: impl });
    const body = await client.request("/quotes", { method: "POST", body: {} });
    assert.equal(body.quotes.length, 1);
  });

  it("does not throw on partiallyUpdated, which carries a usable order", async () => {
    const { impl } = stubFetch([
      {
        status: 200,
        body: { outcome: "partiallyUpdated", order: { id: "ord_1" } },
      },
    ]);
    const client = new ProdigiClient({ config: CONFIG, fetchImpl: impl });
    const body = await client.request(
      "/orders/ord_1/actions/cancel",
      { method: "POST" },
    );
    assert.equal(body.order.id, "ord_1");
  });

  it("converts a timeout abort into a ProdigiApiError", async () => {
    const impl = async (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const client = new ProdigiClient({
      config: { ...CONFIG, timeoutMs: 5 },
      fetchImpl: impl,
    });
    await assert.rejects(
      () => client.request("/orders"),
      (err) => {
        assert.ok(err instanceof ProdigiApiError);
        assert.equal(err.statusCode, 504);
        assert.match(err.message, /timed out/);
        return true;
      },
    );
  });

  it("follows nextUrl across pages", async () => {
    const { impl, calls } = stubFetch([
      {
        body: {
          outcome: "Ok",
          orders: [{ id: "ord_1" }, { id: "ord_2" }],
          hasMore: true,
          nextUrl: "https://api.sandbox.prodigi.com/v4.0/Orders?Skip=2",
        },
      },
      {
        body: {
          outcome: "Ok",
          orders: [{ id: "ord_3" }],
          hasMore: false,
          nextUrl: null,
        },
      },
    ]);
    const client = new ProdigiClient({ config: CONFIG, fetchImpl: impl });
    const result = await client.paginate("/orders", "orders", 10);
    assert.deepEqual(
      result.items.map((i) => i.id),
      ["ord_1", "ord_2", "ord_3"],
    );
    assert.equal(result.pagesFetched, 2);
    assert.equal(result.hasMore, false);
    assert.match(calls[1].url, /Skip=2/);
  });

  it("stops paginating once maxItems is reached", async () => {
    const { impl, calls } = stubFetch([
      {
        body: {
          outcome: "Ok",
          orders: [{ id: "ord_1" }, { id: "ord_2" }],
          hasMore: true,
          nextUrl: "https://api.sandbox.prodigi.com/v4.0/Orders?Skip=2",
        },
      },
    ]);
    const client = new ProdigiClient({ config: CONFIG, fetchImpl: impl });
    const result = await client.paginate("/orders", "orders", 2);
    assert.equal(result.items.length, 2);
    assert.equal(calls.length, 1);
    assert.equal(result.hasMore, true);
  });
});