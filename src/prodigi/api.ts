import type { ProdigiClient, RequestOptions } from "./client.js";
import type {
  ApiResponse,
  CreateQuoteRequest,
  Order,
  Product,
  Quote,
} from "./types.js";

/** Payload wrapper used by every list endpoint. */
interface ListEnvelope<T> {
  outcome?: string;
  hasMore?: boolean;
  nextUrl?: string | null;
  [key: string]: unknown;
}

export class ProdigiApi {
  constructor(private readonly client: ProdigiClient) {}

  /* ------------------------------------------------------------------ */
  /* Products                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Full product definition for a SKU: dimensions, valid attribute values,
   * required print areas, per-variant destinations and print resolutions.
   * Call this before ordering to discover what a SKU actually accepts.
   */
  async getProduct(sku: string, options: { signal?: AbortSignal } = {}) {
    const body = await this.client.request<ApiResponse<Product>>(
      `/products/${encodeURIComponent(sku)}`,
      options,
    );
    return { outcome: body.outcome, product: body.product as Product };
  }

  /**
   * Spine width (mm) needed for a photobook of `numberOfPages` pages shipped to
   * a destination. Required to size a spine image correctly.
   */
  async getSpineInfo(
    input: { sku: string; destinationCountryCode: string; numberOfPages: number; state?: string },
    options: { signal?: AbortSignal } = {},
  ) {
    const body = await this.client.request<{
      success?: boolean;
      message?: string;
      spineInfo?: { widthMm: number };
    }>(
      "/products/spine",
      { method: "POST", body: input, ...options },
    );
    return body;
  }

  /* ------------------------------------------------------------------ */
  /* Quotes                                                             */
  /* ------------------------------------------------------------------ */

  /**
   * Prices a basket without creating an order. Returns one quote per shipping
   * method unless `shippingMethod` narrows it to a single option.
   */
  async createQuote(input: CreateQuoteRequest, options: { signal?: AbortSignal } = {}) {
    const body = await this.client.request<ApiResponse<Quote>>("/quotes", {
      method: "POST",
      body: input,
      ...options,
    });
    return {
      outcome: body.outcome,
      issues:
        (body.issues as
          | { errorCode: string; description: string; objectId?: string | null }[]
          | undefined) ?? [],
      quotes: (body.quotes as Quote[] | undefined) ?? [],
      traceParent: body.traceParent,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Orders                                                             */
  /* ------------------------------------------------------------------ */

  async getOrder(prodigiOrderId: string, options: { signal?: AbortSignal } = {}) {
    const body = await this.client.request<ApiResponse<Order>>(
      `/orders/${encodeURIComponent(prodigiOrderId)}`,
      options,
    );
    return { outcome: body.outcome, order: body.order as Order };
  }

  /** Lists orders, auto-paginating up to `maxItems`. */
  async listOrders(
    filters: {
      top?: number;
      skip?: number;
      createdFrom?: string;
      createdTo?: string;
      status?: "draft" | "awaitingPayment" | "inProgress" | "complete" | "cancelled";
      orderIds?: string[];
      merchantReferences?: string[];
    } = {},
    opts: { maxItems?: number; signal?: AbortSignal } = {},
  ) {
    const maxItems = opts.maxItems ?? 20;
    const query: RequestOptions["query"] = {
      top: Math.min(filters.top ?? maxItems, 100),
      skip: filters.skip,
      createdFrom: filters.createdFrom,
      createdTo: filters.createdTo,
      status: filters.status,
      orderIds: filters.orderIds,
      merchantReferences: filters.merchantReferences,
    };
    return this.client.paginate<Order & { id: string }>(
      "/orders",
      "orders",
      maxItems,
      query,
      opts.signal,
    );
  }

  /* ------------------------------------------------------------------ */
  /* Order actions                                                      */
  /* ------------------------------------------------------------------ */

}

export type { ListEnvelope };
