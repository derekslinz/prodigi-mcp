/**
 * Static guidance exposed as an MCP resource. Kept in its own module so
 * both the server instructions and the resource registration can use it
 * without a circular import.
 */

/**
 * Guidance surfaced to clients so a model picks up Prodigi's non-obvious
 * constraints (URL-reachable assets, order lifecycle, quote-before-order)
 * without needing them restated in every tool description.
 */
export const WORKFLOW_GUIDANCE = `# Prodigi Print API (v4)

Prodigi is a print-on-demand and photo-fulfilment network. You submit an order
with SKUs and public image URLs; Prodigi prints the items at the cheapest
suitable lab and ships them to the recipient.

## The correct sequence for a new order

1. **\`prodigi_get_product\`** for every SKU. Never guess a SKU or an attribute
   value. This returns which attributes exist and their legal values, which
   print areas require assets, recommended pixel dimensions, and which
   countries each variant can ship to.
2. **\`prodigi_create_quote\`** with the basket and destination country. This
   prices items and shipping per shipping tier and shows the courier and
   fulfilling lab. Show the customer the options.
3. **\`prodigi_create_order\`** only once the customer has committed. This
   charges the account and starts fulfilment.

Skipping straight to step 3 is the most common failure: a typo'd SKU, an
invalid attribute value, or a product that does not ship to the destination
will be rejected or will produce an unusable order.

## Hard requirements

- **Asset URLs must be publicly downloadable** by Prodigi's servers, without
  authentication. Signed URLs that expire quickly, or URLs behind a login, will
  fail. Prodigi retries a failing download 10 times, then marks the asset
  \`Invalid\`.
- **\`countryCode\` is ISO 3166-1 alpha-2** (\`US\`, \`GB\`, \`DE\`), not a
  currency or a full country name.
- **\`currency\` is ISO 4217 alpha-3** (\`USD\`, \`GBP\`, \`EUR\`).
- **Amounts are decimal strings**, e.g. \`"15.00"\`, not numbers.
- **SKUs are case-insensitive** on input and come back upper-cased; store the
  canonical form if you need to match on them.

## Order lifecycle

An order moves through: assets downloaded → print-ready preparation → lab
allocation → production → shipping → complete. The \`status.stage\` is
\`InProgress\`, \`Complete\` or \`Cancelled\`. The \`status.details\` object
reports per-stage state and is the best signal for "where is my order".

Callbacks (CloudEvents) are sent to the \`callbackUrl\` you supply, or the
account-wide default, when the stage changes. This server does not receive
them - it polls. To react to updates, either poll \`prodigi_get_order\` or build
your own webhook receiver.

### Manual approval mode hides orders

If the account is configured for manual order approval in the Prodigi
dashboard, submitted orders are **invisible to the API** until they are
released. Consequences:

- \`prodigi_list_orders\` returns empty even though orders were submitted.
- \`prodigi_get_order\` on a submitted-but-unreleased ID returns
  \`entityNotFound\` - the order exists, it is just not visible yet.
- Order actions such as cancel are unavailable on a hidden order, so an
  accidental submission cannot be undone through the API.

Treat a "not found" on a freshly submitted order as ambiguous rather than
conclusive. Quote and product lookups are unaffected and remain safe to call.

### Actions narrow over time

\`prodigi_get_order_actions\` reports what is still possible. Once fulfilment
begins, cancel / recipient / shipping changes are refused with
\`actionNotAvailable\`. Metadata updates stay available throughout. When a
partially-applied change happens, Prodigi returns \`partiallyUpdated\` plus
per-shipment results - always read them rather than assuming success.

## Idempotency

\`idempotencyKey\` is a GUID unique to an order. If Prodigi has seen it, it
returns the existing order (\`outcome: AlreadyExists\`) instead of creating a
duplicate. Use it for any order submission that could be retried. It is *not*
the same as \`merchantReference\`, which is free-form and not deduplicated.

## Sizing and orientation

- \`fillPrintArea\` (default) crops the image centrally to fill the area.
- \`fitPrintArea\` shrinks the whole image in, leaving white space.
- \`stretchToPrintArea\` distorts to fill - avoid unless asked.
- Only PNG and JPEG are resized. **PDFs print at their native size.**
- Prodigi auto-rotates landscape images to best fit, so \`fillPrintArea\` on a
  4500x3000 image ordered as a 10x15 print yields a 3000x4500 result.

## Photobooks

Photobooks need a \`pageCount\` on the page asset and a separate \`spine\`
print-area asset. Get the required spine width in millimetres from
\`prodigi_get_spine_info\` for the exact page count and destination, and
generate the spine image at that width.
`;

