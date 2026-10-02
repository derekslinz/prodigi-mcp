# prodigi-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server for the
[Prodigi Print API v4](https://www.prodigi.com/print-api/docs/reference/).

Prodigi is a print-on-demand network: you post an order containing product SKUs
and public image URLs, and Prodigi prints the items at the cheapest suitable lab
and ships them to the customer. This server exposes that workflow to an LLM so
an assistant can quote a basket, place an order, and track it through
fulfilment.

## Tools

| Tool | Purpose |
| --- | --- |
| `prodigi_get_product` | Full SKU definition: valid attributes, print areas, resolutions, destinations |
| `prodigi_get_spine_info` | Photobook spine width in mm for a page count and destination |
| `prodigi_create_quote` | Price a basket per shipping tier, with courier and lab breakdown |
| `prodigi_create_order` | Submit a real, billable order |
| `prodigi_get_order` | Full order: status, stages, shipments, tracking, charges |
| `prodigi_list_orders` | Filtered, auto-paginated order list |
| `prodigi_get_order_actions` | Which changes are still permitted on an order |
| `prodigi_cancel_order` | Cancel an order (refund depends on fulfilment stage) |
| `prodigi_update_shipping_method` | Change shipping tier before fulfilment |
| `prodigi_update_recipient` | Correct address or contact details |
| `prodigi_update_order_metadata` | Replace the order's JSON metadata |
| `prodigi_get_configuration` | Report the active environment with a masked key |

### Resources

- `prodigi://guide/workflow` — ordering workflow, hard requirements, lifecycle
- `prodigi://product/{sku}` and `prodigi://order/{orderId}` — raw API objects
- `prodigi://config/environment` — active environment (never exposes the key)

## Install

```bash
npm install
npm run build
```

Requires Node 18 or newer.

## Configuration

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `PRODIGI_API_KEY` | yes | — | From [dashboard.prodigi.com](https://dashboard.prodigi.com/) |
| `PRODIGI_ENVIRONMENT` | no | `sandbox` | `sandbox` or `live` |
| `PRODIGI_TIMEOUT_MS` | no | `60000` | Per-request timeout |

Sandbox and live keys are **different credentials**. When the environment is
unset the server defaults to sandbox, since accidentally ordering against live
is the expensive mistake to avoid.

### Claude Desktop / Claude Code

Rather than hand-editing JSON, register the server with the bundled installer:

```bash
npm run build
node dist/setup.js --interactive
```

It detects installed clients, backs up the config before writing, preserves
unrelated entries and key ordering, and is safe to re-run — an existing entry is
updated rather than duplicated.

```bash
node dist/setup.js --environment sandbox
node dist/setup.js --client claude-desktop --environment live --key <key>
node dist/setup.js --print-config --environment sandbox   # preview only
```

| Flag | Effect |
| --- | --- |
| `-i`, `--interactive` | Ask before each change |
| `-n`, `--dry-run` | Report what would change without writing |
| `-p`, `--print-config` | Print the resulting `mcpServers` JSON and exit |
| `--no-redact` | With `--print-config`, show secrets unmasked |
| `--client <id>` | `claude-desktop`, `claude-code`, or `claude-code-project` |
| `--project-dir <path>` | Repository for `--client claude-code-project` |
| `--key <key>` | Embed a key; omit to rely on the client's own environment |
| `--environment <env>` | `sandbox` or `live` — **required**, or asked under `-i` |

`--print-config` redacts anything key-shaped by default, including keys belonging
to *other* MCP servers already in the config. It writes nothing.

### The environment is never assumed

`--environment` is required unless you pass `--interactive`, which asks first.
There is deliberately no default. A sandbox key pointed at live simply fails
authentication, but a live key silently treated as sandbox is worse — and
guessing wrong about *which* key you hold is how that happens. Pick
deliberately; `production` is accepted as a synonym for `live`.

```bash
node dist/setup.js -i
# Environment - sandbox (no real orders, nothing charged) or live
# (real orders, billed)? [s/l]: l
# Prodigi API key (blank to use the client's environment): 
```

Answers of `s`/`sandbox` and `l`/`live` are both accepted; anything else is
rejected rather than guessed at.

### Project scope requires an explicit directory

`claude-code-project` writes `.mcp.json` into a repository, so it needs
`--project-dir`. The current directory is never assumed:

```bash
node dist/setup.js --client claude-code-project \
  --project-dir ../my-app --environment sandbox
```

Without it the command fails rather than dropping a `.mcp.json` into whatever
directory you happened to run from — including this repository. Prefer user scope
(`claude-code`, the default) when you don't need a per-repo config.

### Project scope and secrets

Combining `--project-dir` with `--key` would put a live credential in a
committable file, so the installer adds `.mcp.json` to *that repository's*
`.gitignore` automatically:

```bash
node dist/setup.js --client claude-code-project --project-dir ../my-app \
  --environment live --key <key>
#   added    Claude Code (project: ../my-app) -> ../my-app/.mcp.json
#            added .mcp.json to .gitignore (it holds your API key)
```

Omit `--key` and nothing is ignored — the config stays shareable and each
contributor supplies their own key.

If `.mcp.json` was already committed before this protection existed, the
installer warns that it is still tracked and needs `git rm --cached .mcp.json`.
Rotate the key if it was ever pushed.

To configure manually instead:

```json
{
  "mcpServers": {
    "prodigi": {
      "command": "node",
      "args": ["/absolute/path/to/prodigi-mcp/dist/index.js"]
    }
  }
}
```

For Claude Code, `claude mcp add prodigi --env PRODIGI_API_KEY=... -- node /path/dist/index.js`
does the same thing.

## How the tools are meant to be used

The correct sequence is always **look up → quote → order**:

1. `prodigi_get_product` for every SKU. Attributes, print areas and shipping
   destinations all vary per product, and guessing any of them is the most
   common cause of a rejected order.
2. `prodigi_create_quote` for the destination country. This prices items and
   shipping per tier and reveals which labs and couriers would fulfil it.
3. `prodigi_create_order` once the customer has actually committed. This
   charges the account and begins fulfilment.

### Things that will bite you

- **Asset URLs must be publicly downloadable** by Prodigi's servers, with no
  authentication. Expiring signed URLs fail after 10 retries and the asset is
  marked `Invalid`.
- `countryCode` is ISO 3166-1 **alpha-2** (`US`, `GB`); `currency` is ISO 4217
  **alpha-3** (`USD`, `GBP`); amounts are **decimal strings** (`"15.00"`).
- `sizing` defaults to `fillPrintArea` (crop to fill) and `printArea` defaults to
  `default`, so the common case needs no extra fields.
- Only PNG and JPEG are resized — **PDFs print at their native size**.
- Photobooks need both a `pageCount` on the page asset and a separate `spine`
  asset sized from `prodigi_get_spine_info`.
- Include `recipientCost` and recipient `email`/`phoneNumber` on international
  orders; couriers need them to clear customs.
- Use `idempotencyKey` on any order submission that could be retried. It is not
  the same as `merchantReference`, which is free-form and not deduplicated.

### Actions narrow as the order progresses

Cancel, recipient and shipping changes stop working once fulfilment starts and
return `actionNotAvailable`. Check `prodigi_get_order_actions` first. Metadata
updates remain available throughout. When Prodigi can only apply part of a
change it returns `partiallyUpdated` plus per-shipment results — the server
surfaces those rather than reporting a blanket success.

### Callbacks

This server polls; it does not receive Prodigi's CloudEvents webhooks. Supply
`callbackUrl` when creating an order and build your own receiver if you need
push-based updates.

## Development

```bash
npm run build       # compile to dist/
npm run typecheck   # types only
npm test            # build, then run the suite
node scripts/smoke.mjs   # boot the real stdio server and inspect the surface
```

Two scripts exercise a real Prodigi account:

```bash
# Read-only: product, quote and order-read endpoints. Safe on live.
PRODIGI_API_KEY=... PRODIGI_ENVIRONMENT=live node scripts/live-check.mjs

# Full order lifecycle: create -> update -> cancel. SANDBOX ONLY.
# Refuses to run against live without PRODIGI_ALLOW_LIVE=1.
PRODIGI_API_KEY=... PRODIGI_ENVIRONMENT=sandbox node scripts/sandbox-order-check.mjs
```

Tests run against a stubbed HTTP layer and drive the actual MCP server over an
in-memory transport, so tool wiring, argument validation, and result formatting
are all covered without network access. The lifecycle script closes the
remaining gap by exercising order creation and the mutation actions against
sandbox, where orders are never fulfilled or charged.

Note that `sandbox-order-check.mjs` hardcodes the attribute set for
`GLOBAL-CAN-10X10`. Point it at a different SKU via `PRODIGI_TEST_SKU` and you
must first read that product's required attributes with `prodigi_get_product`.

## Layout

```
src/
  index.ts               stdio entrypoint
  server.ts              server construction, tool wiring, instructions
  docs.ts                workflow guidance text
  resources.ts           resource + template registration
  prodigi/
    types.ts             API types
    config.ts            env loading and validation
    client.ts            HTTP client, error mapping, pagination
    api.ts               one method per endpoint
  tools/
    schemas.ts           shared Zod schemas
    products.ts          SKU and spine lookups
    quotes.ts            quoting
    orders.ts            create, get, list
    order-actions.ts     cancel, update shipping/recipient/metadata
    error-handler.ts     wraps handlers so API errors reach the model usefully
```

## License

MIT