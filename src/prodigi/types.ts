/**
 * TypeScript types for the Prodigi Print API v4.
 *
 * Source: https://www.prodigi.com/print-api/docs/reference/
 *
 * Every response from the API is wrapped in an `outcome` discriminator plus the
 * relevant payload object. Rather than model each endpoint's bespoke response
 * shape, `ApiResponse` keeps the raw body so no field is ever lost, while the
 * helper `requireOk()` narrows to a specific outcome for type-safe access.
 */

/* -------------------------------------------------------------------------- */
/* Shared primitives                                                           */
/* -------------------------------------------------------------------------- */

export interface Cost {
  /** Decimal value as a string, e.g. "7.50". Positive is a debit. */
  amount: string;
  /** Three-letter ISO currency code. */
  currency: string;
}

export interface Issue {
  objectId?: string;
  errorCode: string;
  description: string;
  authorisationDetails?: AuthorisationDetails;
}

export interface AuthorisationDetails {
  authorisationUrl: string;
  paymentDetails: Cost;
}

export interface StatusDetails {
  downloadAssets: StageValue;
  allocateProductionLocation: StageValue;
  printReadyAssetsPrepared: StageValue;
  inProduction: StageValue;
  shipping: StageValue;
}

export type StageValue = "NotStarted" | "InProgress" | "Complete" | "Error";

export interface Status {
  /** InProgress | Complete | Cancelled. */
  stage: string;
  issues: Issue[];
  details?: StatusDetails;
}

export interface Address {
  line1: string;
  line2?: string | null;
  postalOrZipCode: string;
  countryCode: string;
  townOrCity: string;
  stateOrCounty?: string | null;
}

export interface Recipient {
  name: string;
  email?: string | null;
  phoneNumber?: string | null;
  address: Address;
}

export interface Tracking {
  url?: string;
  number?: string;
}

export interface FulfillmentLocation {
  countryCode: string;
  labCode: string;
}

export interface Carrier {
  name: string;
  service: string;
}

export interface OrderShipment {
  id: string;
  /** Processing | Cancelled | Shipped */
  status: string;
  carrier?: Carrier;
  dispatchDate?: string;
  items: { itemId: string }[];
  tracking?: Tracking;
  fulfillmentLocation?: FulfillmentLocation;
}

export interface Asset {
  id?: string;
  printArea: string;
  status?: string;
  url: string;
  thumbnailUrl?: string;
  md5Hash?: string;
  pageCount?: number;
}

export interface BrandingAsset {
  url: string;
}

export type BrandingKey =
  | "postcard"
  | "flyer"
  | "packing_slip_bw"
  | "packing_slip_color"
  | "sticker_exterior_round"
  | "sticker_exterior_rectangle"
  | "sticker_interior_round"
  | "sticker_interior_rectangle";

export interface Branding {
  postcard?: BrandingAsset;
  flyer?: BrandingAsset;
  packing_slip_bw?: BrandingAsset;
  packing_slip_color?: BrandingAsset;
  sticker_exterior_round?: BrandingAsset;
  sticker_exterior_rectangle?: BrandingAsset;
  sticker_interior_round?: BrandingAsset;
  sticker_interior_rectangle?: BrandingAsset;
}

export interface ChargeItem {
  id?: string;
  shipmentId?: string | null;
  itemId?: string | null;
  cost: Cost;
}

export interface Charge {
  id?: string;
  chargeType?: string;
  prodigiInvoiceNumber?: string | null;
  totalCost?: Cost;
  items?: ChargeItem[];
}

export interface PackingSlip {
  url: string;
  status?: string;
}

/* -------------------------------------------------------------------------- */
/* Order object                                                                */
/* -------------------------------------------------------------------------- */

export interface Order {
  id: string;
  created: string;
  lastUpdated?: string;
  callbackUrl?: string | null;
  merchantReference?: string | null;
  shippingMethod: string;
  idempotencyKey?: string | null;
  status: Status;
  charges: Charge[];
  shipments: OrderShipment[];
  recipient: Recipient;
  branding?: Branding | null;
  items: OrderItem[];
  packingSlip?: PackingSlip | null;
  metadata?: Record<string, unknown> | null;
}

export interface OrderItem {
  id: string;
  /** Ok | Invalid | NotYetDownloaded */
  status: string;
  merchantReference?: string | null;
  sku: string;
  copies: number;
  sizing: Sizing;
  attributes: Record<string, string>;
  assets: Asset[];
  recipientCost?: Cost | null;
}

/** fillPrintArea (default crop) | fitPrintArea (letterbox) | stretchToPrintArea. */
export type Sizing = "fillPrintArea" | "fitPrintArea" | "stretchToPrintArea";

/* -------------------------------------------------------------------------- */
/* Request payloads                                                            */
/* -------------------------------------------------------------------------- */

export interface RequestAsset {
  printArea: string;
  url: string;
  md5Hash?: string;
  pageCount?: number;
}

export interface RequestOrderItem {
  merchantReference?: string;
  sku: string;
  copies: number;
  sizing: Sizing;
  attributes?: Record<string, string>;
  assets: RequestAsset[];
  recipientCost?: Cost;
}

/**
 * Recipient as sent on order create / update. The API accepts `null` for the
 * optional contact fields, so they are nullable as well as optional here.
 */
export interface RequestRecipient {
  name: string;
  email?: string | null;
  phoneNumber?: string | null;
  address: Address;
}

/* -------------------------------------------------------------------------- */
/* Order actions                                                               */
/* -------------------------------------------------------------------------- */

export interface ActionsAvailability {
  isAvailable: "Yes" | "No";
}

export interface OrderActions {
  cancel: ActionsAvailability;
  changeRecipientDetails: ActionsAvailability;
  changeShippingMethod: ActionsAvailability;
  changeMetaData: ActionsAvailability;
}

export interface ShipmentUpdateResult {
  shipmentId: string;
  successful: boolean;
  errorCode?: string;
  description?: string;
}

/* -------------------------------------------------------------------------- */
/* Quotes                                                                      */
/* -------------------------------------------------------------------------- */

export interface Quote {
  shipmentMethod: string;
  costSummary: {
    items: Cost;
    shipping: Cost;
    /** Absent in some responses; the live API supplies it. */
    branding?: Cost;
    /** Absent in the published examples; the live API supplies it. */
    totalCost?: Cost;
    /** Absent in the published examples; the live API supplies it. */
    totalTax?: Cost;
  };
  shipments: QuoteShipment[];
  items: QuoteItem[];
}

export interface QuoteShipment {
  carrier: Carrier;
  fulfillmentLocation: FulfillmentLocation;
  cost: Cost;
  items: string[];
}

export interface QuoteItem {
  id: string;
  sku: string;
  copies: number;
  unitCost: Cost;
  attributes: Record<string, string>;
  assets: { printArea: string; pageCount?: number }[];
}

export interface CreateQuoteRequest {
  shippingMethod?: string;
  destinationCountryCode: string;
  currencyCode?: string;
  items: {
    sku: string;
    copies: number;
    attributes?: Record<string, string>;
    assets: { printArea: string; pageCount?: number }[];
  }[];
}

/* -------------------------------------------------------------------------- */
/* Product details                                                             */
/* -------------------------------------------------------------------------- */

export interface Product {
  sku: string;
  description: string;
  productDimensions: {
    width: number;
    height: number;
    units: string;
  };
  attributes: Record<string, string[]>;
  printAreas: Record<string, { required: boolean }>;
  variants: ProductVariant[];
}

export interface ProductVariant {
  attributes: Record<string, string>;
  shipsTo: string[];
  printAreaSizes: Record<
    string,
    { horizontalResolution: number; verticalResolution: number }
  >;
}

export interface CreateOrderRequest {
  merchantReference?: string;
  callbackUrl?: string;
  shippingMethod: string;
  idempotencyKey?: string;
  recipient: RequestRecipient;
  branding?: Branding;
  items: RequestOrderItem[];
  metadata?: Record<string, unknown>;
  packingSlip?: PackingSlip;
}

/* -------------------------------------------------------------------------- */
/* Response envelope                                                           */
/* -------------------------------------------------------------------------- */

/**
 * A raw API response body. `outcome` is always present and disambiguates how to
 * read the remaining fields.
 */
export interface ApiResponse<T = Record<string, unknown>> {
  outcome?: string;
  traceParent?: string;
  [key: string]: unknown;
  // Allows `requireOk<T>()` consumers to keep typing while the envelope stays loose.
  __payload?: T;
}

export interface ErrorBody {
  statusText?: string;
  statusCode?: number;
  data?: unknown;
  traceParent?: string;
}

export type ProdigiEnvironment = "sandbox" | "live";
