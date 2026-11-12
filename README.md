# Snap & Sell

**Trusted selling for the world's newest PayPal sellers. AI agents haggle for a fair price, PayPal holds the money, and Meta's Muse Spark checks the parcel against the listing before the seller is paid.**

For about 20 years, people in Nigeria could not receive PayPal payments. In January 2026 PayPal [returned to Nigeria through Paga](https://techcabal.com/2026/01/27/paypal-returns-to-nigeria-after-two-decades-this-time-through-paga/). Millions of tailors, bead makers and dye workers can now be paid by buyers abroad. Two problems remain:

- **Trust.** A buyer in London has no reason to trust an unknown seller in Lagos, and a new seller has no reviews.
- **Reach.** Most small sellers have no online store, no listing skills, and no idea how to price in dollars. More shopping is also starting to happen through AI agents.

Snap & Sell solves both:

1. **Snap.** The seller takes one photo. Muse Spark writes the listing and a suggested USD price, and explains the price.
2. **Haggle.** The buyer's AI agent negotiates with the seller's AI agent, Lagos-market style, live on screen. The seller's lowest price is private and **enforced in code**: the seller's agent cannot go below it, and the buyer's agent cannot go over the buyer's budget.
3. **Hold.** The buyer approves on PayPal. The order uses `intent: AUTHORIZE`, so **PayPal holds the money; it is not sent yet**.
4. **Prove.** The seller photographs the packed item with its waybill. Muse Spark compares it with the listing photo ("same buckle, same swirl pattern"), reads the tracking number and recipient, and checks the recipient against the buyer's PayPal shipping name.
5. **Release.** Fixed rules in code, not the model, decide what happens. If the item matches and the waybill is readable, the authorization is **captured** and tracking is **added to the PayPal order**. If it is a different item, the money **stays held** and the buyer can cancel (the authorization is **voided**, so the buyer is not charged).

The human stays in control: no tool can move money, agents only start checkouts the buyer approves, and agent orders are capped.

**Live demo:** https://snapsell.finessedev.space · **Video:** https://youtu.be/qeOOitYo-Es

---

## Test it in 3 minutes

**Sandbox buyer** (PayPal sandbox, fake money): `sb-nu047p53749324@personal.example.com` / `0$Bn0cM;`

1. **Haggle and buy with an agent:** open **Shop** (`/store`). The AI shopping agent sits beside the products. Tap *"Get me a deal on the Ankara buckle tote, my max is $34"*, or **🤝 Haggle with AI** on any product, and watch the two agents negotiate. Then tap *"Buy it"*, click **Review & approve on PayPal** and log in with the sandbox buyer. You land on the order page: **PayPal is holding your money**. The order is also listed under **My orders** (`/orders`). No buyer account is needed; PayPal is the login.
2. **Ship and get paid:** open `/dashboard`, click **Ship & get paid** on that order, open *"No parcel to hand? Try a sample photo"* and choose **✗ A different item (swap)**. The check catches the swap and the money stays held. Then choose **✓ Correct item**: the money is released and the tracking number is added to the PayPal order.
3. **Sell:** open `/`, upload any product photo, press **Write my listing with AI**, set your private lowest price, then **Publish**.
4. **Pay with buttons:** open any product page and pay with the PayPal, Venmo or Pay Later buttons.

The sample photos are generated on the server: the listing photo (or another product, for a swap) on a cardboard background, with a waybill addressed to the buyer's PayPal shipping name. You can also upload a real photo.

---

## How PayPal is used

| PayPal capability | Where |
|---|---|
| **Orders v2, `intent: AUTHORIZE`** (line items, amount breakdown) | `src/paypal.js` `createOrder` |
| **Authorize order** `POST /v2/checkout/orders/{id}/authorize`: holds funds after approval; reads shipping name and country | `authorizeOrder` |
| **Capture authorization** `POST /v2/payments/authorizations/{id}/capture` (`final_capture`, `invoice_id`): releases money after proof of shipment | `captureAuthorization`, called only from `src/escrow.js` |
| **Void authorization** `POST /v2/payments/authorizations/{id}/void`: buyer cancels a flagged order and is not charged | `voidAuthorization` |
| **Add tracking** `POST /v2/checkout/orders/{id}/track`: the tracking number read from the waybill photo | `addTracking` |
| **Webhooks** with `POST /v1/notifications/verify-webhook-signature` | `POST /api/paypal/webhook` |
| **PayPal JS SDK** buttons (`intent=authorize`, Venmo and Pay Later enabled) | `public/product.html` |
| **Redirect approval flow** (`experience_context`, `payer-action` link) for AI agents and QR codes | `createOrder`, `GET /paypal/return` |
| OAuth 2.0 client credentials with token caching; `PayPal-Request-Id` idempotency on every write | `src/paypal.js` |

## How AI is used

All calls use **Muse Spark** (`muse-spark-1.3`) through the Meta Model **Responses API**, with strict JSON schemas, zod validation, and short timeouts with retries.

| Job | How | Where |
|---|---|---|
| Photo → listing (title, description, price with reasoning, tags, WhatsApp caption, confidence) | Vision + structured output | `src/ai.js` `draftListing` |
| **Proof of shipment**: listing photo + parcel photo → same item? differences, tracking number, carrier, recipient, recipient match | Two images in one request + structured output | `verifyShipment`; money decision in `src/escrow.js` `decide` |
| **Haggling**: a buyer agent and a seller agent take turns | Structured output per turn; the server clamps every number | `haggle` |
| Buyer shopping agent | Tool calling: `search_products`, `get_product`, `negotiate_price`, `start_checkout`, `get_order_status`, streamed live over SSE | `runShoppingAgent`, `src/agentTools.js` |

**The model reports, code decides.** Release needs `sameItem` with confidence ≥ 0.8, a readable tracking number and a recipient that does not contradict PayPal's shipping name. A confident "different item" flags the order. Anything else keeps the money held.

## Seller dashboard (AG Grid)

`/dashboard` is where the seller manages the escrow. It's built with AG Grid Community:

- **Orders:**
  - Rows are coloured by where the money is (held, flagged, paid, cancelled).
  - Status chips filter the list, alongside quick search and per-column floating filters.
  - An **AI parcel check** column shows the verdict and a confidence bar; hover for the model's summary.
  - A **haggled off** column shows what agents saved the buyer, and **hold expires** counts down the PayPal authorization.
  - A **pinned totals row** shows held vs released for the current filter.
  - **Export CSV**.
  - The **Ship & get paid** button opens the proof-of-shipment check.
- **Products:** double-click to edit the price, the **private lowest price** used by the haggling agent, haggling on/off and stock. Edits save through `PATCH /api/products/:id`, and the floor is capped at the price.

## Agent-ready store

- **Manifest:** `GET /.well-known/agent-store.json` (tools, escrow rules, negotiation).
- **HTTP tools:** `GET /api/agent/search?q=`, `GET /api/agent/products/:id`, `POST /api/agent/negotiate`, `POST /api/agent/checkout`, `GET /api/agent/orders/:id`.
- **MCP server:** `npm run mcp` (stdio), with the same five tools. Point it at any deployment with `SNAP_SELL_URL`:

```json
{ "mcpServers": { "snap-and-sell": { "command": "node", "args": ["/path/to/snap-and-sell/src/mcp.js"], "env": { "SNAP_SELL_URL": "https://your-deployment.onrender.com" } } } }
```

**Guardrails:** no tool can capture or move money. Every order needs the buyer's approval on PayPal. The seller's floor price never leaves the server: it is not in any API response or in the buyer agent's prompt. Deals expire after 30 minutes and can be used once. Agent orders are capped (`AGENT_MAX_ORDER_USD`).

## Architecture

```
Seller photo ─► Muse Spark (vision) ─► listing ─► store
                                                   │
Buyer agent ──tools──► search ─► negotiate_price ◄─┴─► seller agent (private floor, clamped in code)
      │                               │
      └──► start_checkout ─► PayPal Orders v2 (AUTHORIZE) ─► buyer approves ─► authorize = money HELD
                                                                                   │
Seller parcel photo + listing photo ─► Muse Spark (2 images) ─► decide() ──────────┤
                                                                                   ├─ release ─► capture + add tracking
                                                                                   └─ swap ────► stay held ─► buyer voids
```

## Run it locally

Requirements: Node.js 20+.

```bash
npm install
cp .env.example .env      # PayPal sandbox keys + Meta API key
npm start                 # http://localhost:3000
npm test                  # 13 end-to-end tests against imitations of the PayPal and Meta APIs
```

Without keys the app still runs: PayPal and the AI switch to clearly labelled mock modes.

## Deploy (Render)

Connect the repo on render.com (it reads `render.yaml`). Add `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `META_API_KEY` and optionally `PAYPAL_WEBHOOK_ID`. Use the Starter plan during judging so pages load instantly.

## Tests

`npm test` runs 13 end-to-end tests with fake PayPal and Meta servers and checks the exact requests sent:
- `AUTHORIZE` intent, and nothing is captured on approval.
- The haggling clamps: the seller never goes below the floor, the buyer never goes over budget, and the floor never reaches the buyer side.
- Negotiated price on the PayPal order; deals are single use; the agent spending cap.
- A swapped parcel is flagged with no capture, and the buyer cancel voids the authorization.
- A genuine parcel is captured with `final_capture`, with tracking sent to PayPal, and can't be released twice.
- The release rules.
- The tool-calling loop.
- Only verified webhooks are accepted.
- The manifest.

## Honest limits

- PayPal **sandbox** only. Going live needs a verified PayPal business account (in Nigeria, through Paga).
- A photo check reduces fraud but can't prove what is inside a sealed box. Production would add courier tracking events and PayPal's dispute process.
- PayPal authorizations have an honor period (3 days) and expire after 29 days; sellers need to ship within that window. Reauthorization is not built yet.
- No seller login yet: the dashboard is open for the demo. The data store is a JSON file.
- Demo sellers are fictional. Demo product photos are from Wikimedia Commons (credits in `public/seed/CREDITS.md`).

## Roadmap

Courier API tracking events before capture, Pidgin and Yoruba voice listing, PayPal Payouts for marketplace splits, seller accounts, and publishing catalogs to PayPal's agentic commerce channels.

## Built during the hackathon

Written on 11–12 November 2026 for the PayPal AI Hackathon, with help from Claude (Anthropic) as a coding assistant.

## Licence

MIT. See `LICENSE`.
