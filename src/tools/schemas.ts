import { z } from "zod";

/** Shipping services Prodigi accepts, for orders and quotes. */
export const SHIPPING_METHODS = [
  "Budget",
  "Standard",
  "StandardPlus",
  "Express",
  "Overnight",
] as const;

export const shippingMethodSchema = z
  .enum(SHIPPING_METHODS)
  .describe(
    "Shipping service tier. Prodigi accepts title case here even though the " +
      "quotes docs show lower case; it is case-insensitive server side.",
  );

/** Quote endpoints document lower-case values; keep both spellings available. */
export const quoteShippingMethodSchema = z
  .enum(["budget", "standard", "standardplus", "express", "overnight"])
  .describe(
    "Optional. Omit to receive a quote for every shipping method so they can " +
      "be compared side by side.",
  );

export const sizingSchema = z
  .enum(["fillPrintArea", "fitPrintArea", "stretchToPrintArea"])
  .default("fillPrintArea")
  .describe(
    "How to fit the image to the product's print area. " +
      "fillPrintArea (default) crops centrally to cover the whole area; " +
      "fitPrintArea shrinks the whole image in, leaving white space; " +
      "stretchToPrintArea distorts to fill. Only PNG/JPEG can be resized - " +
      "PDFs are printed at their native size.",
  );

export const addressSchema = z.object({
  line1: z.string().min(1).describe("First line of the address."),
  line2: z
    .string()
    .nullish()
    .describe("Second line of the address. Optional."),
  postalOrZipCode: z.string().min(1).describe("Postcode or ZIP code."),
  countryCode: z
    .string()
    .length(2)
    .describe("Two-letter ISO 3166-1 alpha-2 country code, e.g. US, GB, DE."),
  townOrCity: z.string().min(1).describe("Town or city."),
  stateOrCounty: z
    .string()
    .nullish()
    .describe("State, province or county. Optional but required for some couriers."),
});

export const recipientSchema = z.object({
  name: z.string().min(1).describe("Recipient's full name."),
  email: z
    .string()
    .email()
    .nullish()
    .describe(
      "Recipient email. Optional, but strongly recommended for international " +
        "orders - couriers require a contact for customs.",
    ),
  phoneNumber: z
    .string()
    .nullish()
    .describe(
      "Recipient mobile number. Optional, but required for anything shipped " +
        "from the UK.",
    ),
  address: addressSchema,
});

/** An image to be printed, as required by order items. */
export const orderAssetSchema = z.object({
  printArea: z
    .string()
    .default("default")
    .describe(
      "Name of the target print area. 'default' for most products; " +
        "photobooks also use 'spine', jigsaws 'lid'. Check " +
        "prodigi_get_product to see which areas a SKU needs.",
    ),
  url: z
    .string()
    .url()
    .describe(
      "Publicly reachable URL of the image. Prodigi downloads it from here, " +
        "so the URL must be accessible without authentication.",
    ),
  md5Hash: z
    .string()
    .optional()
    .describe(
      "Expected MD5 of the file. If supplied, Prodigi generates the hash and " +
        "fails the asset if it does not match - useful for guarding against " +
        "truncated uploads.",
    ),
  pageCount: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Total page count for multi-page products (photobooks, magazines). " +
        "Drives additional-page pricing and is required for those SKUs.",
    ),
});

/** An asset as expressed in a quote: no URL, just shape and page count. */
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

export const costSchema = z.object({
  amount: z
    .string()
    .describe("Decimal amount as a string, e.g. \"15.00\"."),
  currency: z
    .string()
    .length(3)
    .describe("Three-letter ISO currency code, e.g. USD, GBP, EUR."),
});

export const brandingSchema = z
  .object({
    postcard: z.object({ url: z.string().url() }).describe("A6 branded card in the package."),
    flyer: z.object({ url: z.string().url() }).describe("A5 marketing insert."),
    packing_slip_bw: z.object({ url: z.string().url() }).describe("Black & white packing slip."),
    packing_slip_color: z.object({ url: z.string().url() }).describe("Full colour packing slip."),
    sticker_exterior_round: z.object({ url: z.string().url() }).describe("Round sticker, outside of packaging."),
    sticker_exterior_rectangle: z.object({ url: z.string().url() }).describe("Rectangular sticker, outside of packaging."),
    sticker_interior_round: z.object({ url: z.string().url() }).describe("Round sticker, inside of package."),
    sticker_interior_rectangle: z.object({ url: z.string().url() }).describe("Rectangular sticker, inside of package."),
  })
  .partial()
  .describe(
    "Optional branded inserts. Each must be a publicly accessible, print-ready " +
      "URL. Per-item pricing and formats are set in your Prodigi dashboard.",
  );

export const orderItemSchema = z.object({
  merchantReference: z
    .string()
    .optional()
    .describe("Your own reference for this line item, echoed back on the order."),
  sku: z
    .string()
    .min(1)
    .describe("Prodigi SKU, e.g. GLOBAL-CFPM-16X20. Validate with prodigi_get_product."),
  copies: z.number().int().positive().describe("Quantity of this product."),
  sizing: sizingSchema,
  attributes: attributesSchema.optional(),
  assets: z
    .array(orderAssetSchema)
    .min(1)
    .describe(
      "Images for this item. Products needing more than one print area " +
        "(e.g. photobook pages + spine) require one asset per required area.",
    ),
  recipientCost: costSchema
    .optional()
    .describe(
      "What you charged the customer for these items. Optional, but include it " +
        "on international orders so couriers can handle customs correctly.",
    ),
});

/** Reusable output text prefix so results read consistently. */
export function summariseOrderOutcome(outcome: string | undefined): string {
  switch (outcome) {
    case "Created":
      return "Order created and submitted to fulfilment.";
    case "OnHold":
      return "Order created but placed on hold by your configured pause window. " +
        "It will submit automatically when the window expires, or you can " +
        "submit it sooner from the Prodigi dashboard.";
    case "AlreadyExists":
      return "An order with this idempotencyKey already existed; the existing " +
        "order was returned and no new order was created.";
    default:
      return `Order request completed with outcome "${outcome ?? "unknown"}".`;
  }
}
