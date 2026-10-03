/**
 * Static guidance exposed as an MCP resource. Kept in its own module so both
 * the server instructions and the resource registration can use it without a
 * circular import.
 */

export const WORKFLOW_GUIDANCE = `# Prodigi Print API (v4) - read-only

Prodigi is a print-on-demand and photo-fulfilment network. Orders are submitted
with product SKUs and public image URLs; Prodigi prints the items at the
cheapest suitable lab and ships them to the customer.

**This server cannot place orders.** It exposes lookups, pricing and order
history only. There is no tool that creates, changes or cancels an order, and
there is no configuration that enables one. To take an order, give the user the
basket and customer details, or hand them to a system that can submit it.

## What you can do

1. **\`prodigi_get_product\`** for a SKU. Returns which attributes exist and their
   legal values, which print areas require assets, recommended pixel
   dimensions, and which countries each variant can ship to.
2. **\`prodigi_create_quote\`** to price a basket. Returns a quote per shipping
   method with item cost, shipping cost, per-shipment courier and fulfilling
   lab, and per-item unit cost.
3. **\`prodigi_get_order\` / \`prodigi_list_orders\`** to inspect existing orders,
   their status and their tracking.
4. **\`prodigi_get_spine_info\`** for the photobook spine width needed at a given
   page count and destination.

## Hard requirements when preparing an order

Even though you cannot submit one, these determine whether an order would
succeed, so check them before handing a basket over.

- **Asset URLs must be publicly downloadable** by Prodigi, with no
  authentication. Expiring signed URLs fail after 10 retries and the asset is
  marked \`Invalid\`.
- \`countryCode\` is ISO 3166-1 alpha-2 (\`US\`, \`GB\`, \`DE\`). \`currency\` is
  ISO 4217 alpha-3 (\`USD\`, \`GBP\`). Amounts are decimal strings (\`"15.00"\`).
- \`sizing\` is **required** on every order item: \`fillPrintArea\` (crop to fill),
  \`fitPrintArea\` (shrink in, leaving white space) or \`stretchToPrintArea\`.
- Only PNG and JPEG are resized. **PDFs print at their native size.**
- Photobooks need a \`pageCount\` on the page asset and a separate \`spine\` asset
  sized from \`prodigi_get_spine_info\`.
- Most products require **every** attribute, not just the obvious one. A canvas
  needs edge, frame, paperType, substrateWeight and wrap.
- Include \`recipientCost\` and the recipient's \`email\` and \`phoneNumber\` on
  international orders; couriers need them to clear customs.
- An \`idempotencyKey\` (a UUID) makes submission safe to retry. Without one, two
  identical submissions create two separately printed and billed orders.

## Order lifecycle, for interpreting what you read

An order moves through assets downloaded, print-ready preparation, lab
allocation, production, shipping, then complete. \`status.stage\` is
\`InProgress\`, \`Complete\` or \`Cancelled\`; \`status.details\` gives per-stage
state and is the best answer to "where is my order".

If the account requires **manual order approval**, submitted orders are
invisible to the API until released. \`prodigi_list_orders\` returns empty and
\`prodigi_get_order\` returns \`entityNotFound\` for an order that genuinely
exists, so treat "not found" as ambiguous rather than conclusive.

## Version note

The published Prodigi reference documents failure outcomes in lower camel case
(\`validationFailed\`). The live API returns them PascalCased
(\`ValidationFailed\`). Treat either spelling as a failure.
`;
