# Devpost submission text (copy and paste)

## Project name
Snap & Sell

## Tagline
Trusted selling for the world's newest PayPal sellers: AI agents haggle, PayPal holds the money, and AI checks the parcel before the seller is paid.

## Inspiration
For about 20 years, people in Nigeria could not receive PayPal payments. In January 2026 PayPal returned through Paga. Millions of tailors, bead makers and dye workers can now be paid from abroad, but a buyer in London has no reason to trust an unknown seller in Lagos, and the seller has no reviews, no online store and no idea how to price in dollars. Trust is the reason inbound payments were closed for so long. We wanted to build trust into every sale from day one, for buyers, for sellers, and for the AI agents that are starting to shop for people.

## What it does
- **Snap:** the seller takes one photo. Muse Spark writes the listing and suggests a dollar price, with its reasoning.
- **Haggle:** the buyer's AI agent negotiates with the seller's AI agent, Lagos-market style, live on screen. The seller's lowest price stays private and is enforced in code: the seller's agent can't go below it and the buyer's agent can't go over budget.
- **Hold:** the buyer approves on PayPal, and PayPal holds the money (an authorization, not a capture).
- **Prove:** the seller photographs the packed item with its waybill. Muse Spark compares it with the listing photo, reads the tracking number and recipient, and checks the recipient against the buyer's PayPal shipping name.
- **Release:** if it matches, the payment is captured and tracking is added to the PayPal order. If the seller packed a different item, the money stays held and the buyer can cancel for free (the authorization is voided).
- **Agent-ready:** a manifest, an HTTP tool API and an MCP server let any AI agent search, haggle, check out and track orders. No tool can move money.

## How we built it
- **PayPal:** Orders v2 with `intent: AUTHORIZE`; authorize on approval; capture the authorization after proof of shipment; void to cancel; add tracking to the order; webhooks verified with the verify-webhook-signature API; JS SDK buttons with Venmo and Pay Later; the redirect approval flow for agents and QR codes; OAuth with token caching; idempotency keys. All in the PayPal sandbox.
- **AI:** Meta's Muse Spark through the Responses API, used four ways: vision for photo-to-listing; two-image comparison plus waybill reading for proof of shipment; structured turns for the two haggling agents; and tool calling for the buyer's shopping agent, streamed live to the browser.
- **Safety by design:** the model reports what it sees; plain code decides whether money moves (confidence thresholds, readable tracking, recipient match). The haggling floor never reaches the buyer side, and every offer is clamped on the server.
- **Stack:** Node.js, Express, sharp, zod, AG Grid Community (seller dashboard), MCP SDK. Deployed on Render. 12 end-to-end tests against imitations of the PayPal and Meta APIs.

## Challenges we ran into
- **Letting AI near money safely.** We split "see" from "decide": Muse Spark only describes the photos, and a small set of fixed rules decides whether to capture, hold or flag.
- **Keeping negotiations honest.** A prompt alone can't stop an agent from going below the seller's floor or leaking it, so the server clamps every offer and never sends the floor to the buyer side.
- **Live demos and slow networks.** An occasional stalled model request could freeze the haggle, so every call has a hard timeout with fast retries.

## Accomplishments we're proud of
In our tests the parcel check caught a swapped bag that looked similar (same type of Ankara tote, different pattern and hardware) with 0.96 confidence, while releasing the genuine parcel. It read the tracking number and recipient correctly each time. A full agent haggle (search, four offers, deal) takes about 20 seconds.

## What we learned
Trust in agentic commerce comes from boundaries more than clever prompts: money held until there is evidence, the model separated from the money decision, private limits enforced in code, and a visible trail for the buyer.

## What's next
Courier tracking events before capture, Pidgin and Yoruba voice listing, PayPal Payouts for marketplace splits, seller accounts, and publishing catalogs to PayPal's agentic commerce channels.

## Built with
paypal, paypal-orders-api, paypal-payments-api, paypal-js-sdk, venmo, meta-muse-spark, mcp, node.js, express, ag-grid, render

## Tools used (for the form)
- **Meta Muse Spark** (`muse-spark-1.3`, Responses API): listing from a photo; two-image proof-of-shipment check with waybill reading; buyer and seller haggling agents; tool-calling shopping agent.
- **PayPal** sandbox: Orders v2 (authorize, track), Payments v2 authorizations (capture, void), webhooks, JS SDK.
- **Model Context Protocol SDK:** MCP server exposing the store's tools to any agent.
- **AG Grid Community:** seller dashboard tables.
- **Render:** hosting.
- **Claude (Anthropic):** coding assistant during the build.
