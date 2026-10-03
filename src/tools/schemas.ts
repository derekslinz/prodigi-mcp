import { z } from "zod";

/**
 * Zod fragments shared by the read-only tools.
 *
 * Everything that only an order-creation payload needed - the recipient, order
 * item and asset request shapes, branding and shipping-method enums - has been
 * removed along with the write tools.
 */

/** Quote endpoints document lower-case values; keep both spellings available. */
export const quoteShippingMethodSchema = z
  .enum(["budget", "standard", "standardplus", "express", "overnight"])
  .describe(
    "Optional. Omit to receive a quote for every shipping method so they " +
      "can be compared side by side.",
  );

export const quoteAssetSchema = z.object({
  printArea: z.string().default("default").describe("Target print area name."),
  pageCount: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Page count for multi-page products, used for page-based pricing."),
});

export const attributesSchema = z
  .record(z.string(), z.string())
  .describe(
    "Product attribute selections keyed by name, e.g. {\"color\": \"black\"} or " +
      "{\"wrap\": \"ImageWrap\"}. Valid names and values come from " +
      "prodigi_get_product; omitting an attribute usually selects the default.",
  );
