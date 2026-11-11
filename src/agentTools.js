// The "agent-ready" surface of the store: the same tools are offered to
// (a) our built-in buyer agent (Muse Spark tool calling), (b) any external agent over
// plain HTTP, and (c) MCP clients via src/mcp.js.
// Safety: no tool can move money. start_checkout only creates a PayPal order the buyer
// must approve on PayPal, and it enforces a per-order cap.
import { config } from './config.js';
import * as store from './store.js';
import * as paypal from './paypal.js';
import * as ai from './ai.js';

export const publicProduct = (p) => ({
  id: p.id,
  title: p.title,
  description: p.description,
  category: p.category,
  condition: p.condition,
  priceUsd: p.priceUsd,
  currency: config.paypal.currency,
  inStock: p.stock > 0,
  seller: p.sellerName || 'Snap & Sell seller',
  sellerCity: p.sellerCity || 'Lagos, Nigeria',
  imageUrl: p.image ? `${config.baseUrl}${p.image}` : null,
  url: `${config.baseUrl}/p/${p.id}`,
  negotiable: p.negotiable !== false,
});

// The seller's private lowest price. Never returned by any tool or API.
export const floorOf = (p) => Math.round(Number(p.floorPriceUsd || p.priceUsd * config.store.defaultFloorRatio) * 100) / 100;

export const orderView = (o) => ({
  orderId: o.id,
  title: o.productTitle,
  amount: o.amount,
  currency: o.currency,
  status: o.status,
  statusText: {
    CREATED: 'Waiting for the buyer to approve on PayPal',
    HELD: 'Paid and held safely by PayPal until the seller ships',
    FLAGGED: 'Parcel photo did not match the listing; money still held',
    PAID: 'Parcel verified; money released to the seller',
    VOIDED: 'Cancelled; the buyer was not charged',
  }[o.status] || o.status,
  trackingNumber: o.tracking?.trackingNumber || null,
  carrier: o.tracking?.carrier || null,
  trackUrl: `${config.baseUrl}/o/${o.id}`,
});

// Flat Responses-API tool format: { type, name, description, parameters }.
export const definitions = [
  {
    type: 'function',
    name: 'search_products',
    description: 'Search the Snap & Sell catalog of products from small Nigerian sellers. Returns up to 5 in-stock matches.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What the buyer wants, e.g. "ankara tote bag"' },
        max_price_usd: { type: 'number', description: 'Optional budget per item in USD' },
      },
      required: ['query'],
    },
  },
  {
    type: 'function',
    name: 'get_product',
    description: 'Get full details for one product by id.',
    parameters: { type: 'object', properties: { product_id: { type: 'string' } }, required: ['product_id'] },
  },
  {
    type: 'function',
    name: 'negotiate_price',
    description:
      "Haggle with the seller's own AI agent for a better price on one product, within the buyer's budget. Returns the agreed price and a deal_id to pass to start_checkout, or no deal. The seller's lowest price is private and enforced by the store.",
    parameters: {
      type: 'object',
      properties: {
        product_id: { type: 'string' },
        max_price_usd: { type: 'number', description: 'The most the buyer will pay for one unit' },
      },
      required: ['product_id', 'max_price_usd'],
    },
  },
  {
    type: 'function',
    name: 'start_checkout',
    description:
      'Create a PayPal checkout for a product the buyer has chosen. Does NOT charge the buyer: returns an approval link the buyer must open and approve on PayPal. After approval PayPal holds the money until the seller proves shipment. Pass deal_id to use a negotiated price.',
    parameters: {
      type: 'object',
      properties: {
        product_id: { type: 'string' },
        quantity: { type: 'integer', minimum: 1, maximum: 5 },
        deal_id: { type: 'string', description: 'Optional deal id from negotiate_price' },
      },
      required: ['product_id'],
    },
  },
  {
    type: 'function',
    name: 'get_order_status',
    description: 'Check an order: is the money held, has the seller shipped and has the parcel been verified, tracking number.',
    parameters: { type: 'object', properties: { order_id: { type: 'string' } }, required: ['order_id'] },
  },
];

/**
 * Execute a tool call. Always returns a JSON-safe object; errors are returned, not thrown,
 * so the agent can explain them.
 */
export async function run(name, args = {}, { agentName = 'Snap & Sell buyer agent', onEvent = () => {} } = {}) {
  try {
    if (name === 'search_products') {
      const products = store.searchProducts({ query: args.query || '', maxPriceUsd: args.max_price_usd });
      return { products: products.map(publicProduct) };
    }

    if (name === 'get_product') {
      const p = store.getProduct(args.product_id);
      if (!p || p.status !== 'active') return { error: 'Product not found or no longer available.' };
      return { product: publicProduct(p) };
    }

    if (name === 'negotiate_price') {
      const p = store.getProduct(args.product_id);
      if (!p || p.status !== 'active' || p.stock < 1) return { error: 'Product not found or out of stock.' };
      if (p.negotiable === false) return { error: 'This seller has fixed prices for this item.', listPriceUsd: p.priceUsd };
      const budget = Number(args.max_price_usd);
      if (!(budget > 0)) return { error: 'max_price_usd must be a positive number.' };
      // Already have a live, unused deal for this item within budget? Reuse it (no second haggle).
      const existing = store.findOpenDeal(p.id, String(agentName).slice(0, 60));
      if (existing && existing.priceUsd <= budget) {
        return { agreed: true, dealId: existing.id, priceUsd: existing.priceUsd, listPriceUsd: p.priceUsd, savedUsd: Math.round((p.priceUsd - existing.priceUsd) * 100) / 100, expiresAt: existing.expiresAt, reused: true, note: 'An agreed deal already exists for this item; use this deal_id with start_checkout.' };
      }
      onEvent({ type: 'haggle_start', productTitle: p.title, listPriceUsd: p.priceUsd, budgetUsd: budget });
      const result = await ai.haggle({ product: p, floorUsd: floorOf(p), budgetUsd: budget, onMessage: (m) => onEvent({ type: 'haggle', ...m }) });
      const transcript = result.transcript.map(({ side, message, offerUsd, accept }) => ({ side, message, offerUsd, accept }));
      if (!result.agreed) {
        onEvent({ type: 'haggle_end', agreed: false });
        return { agreed: false, listPriceUsd: p.priceUsd, transcript, note: 'No deal within the budget. The buyer can still buy at the list price.' };
      }
      const deal = store.addDeal({
        productId: p.id, productTitle: p.title, priceUsd: result.priceUsd, listPriceUsd: p.priceUsd,
        agentName: String(agentName).slice(0, 60), transcript, expiresAt: new Date(Date.now() + config.store.dealTtlMs).toISOString(),
      });
      onEvent({ type: 'haggle_end', agreed: true, priceUsd: deal.priceUsd, dealId: deal.id });
      return { agreed: true, dealId: deal.id, priceUsd: deal.priceUsd, listPriceUsd: p.priceUsd, savedUsd: Math.round((p.priceUsd - deal.priceUsd) * 100) / 100, expiresAt: deal.expiresAt, transcript };
    }

    if (name === 'start_checkout') {
      const p = store.getProduct(args.product_id);
      if (!p || p.status !== 'active' || p.stock < 1) return { error: 'Product not found or out of stock.' };
      let unit = p.priceUsd;
      let deal = null;
      if (args.deal_id) {
        deal = store.getDeal(args.deal_id);
        if (!deal || deal.productId !== p.id) return { error: 'That deal is not for this product.' };
        if (deal.used) return { error: 'That deal was already used.' };
        if (Date.parse(deal.expiresAt) < Date.now()) return { error: 'That deal has expired. Negotiate again.' };
        unit = deal.priceUsd;
      }
      // A deal is for one unit.
      const quantity = deal ? 1 : Math.min(Math.max(parseInt(args.quantity || 1, 10) || 1, 1), Math.min(5, p.stock));
      const total = Math.round(unit * quantity * 100) / 100;
      if (total > config.store.agentMaxOrderUsd) {
        return { error: `Agent orders are capped at $${config.store.agentMaxOrderUsd}. Please buy this directly on the product page.` };
      }
      const order = await paypal.createOrder({
        product: p,
        quantity,
        unitPriceUsd: unit,
        source: 'ai-agent',
        returnUrl: `${config.baseUrl}/paypal/return`,
        cancelUrl: `${config.baseUrl}/p/${p.id}?cancelled=1`,
      });
      if (deal) store.useDeal(deal.id);
      store.addOrder({
        id: order.id,
        productId: p.id,
        productTitle: p.title,
        quantity,
        amount: total,
        listAmount: Math.round(p.priceUsd * quantity * 100) / 100,
        dealId: deal?.id || null,
        currency: config.paypal.currency,
        status: 'CREATED',
        channel: 'ai-agent',
        agentName: String(agentName).slice(0, 60),
      });
      return {
        orderId: order.id,
        title: p.title,
        quantity,
        total,
        currency: config.paypal.currency,
        negotiated: Boolean(deal),
        approveUrl: order.approveUrl,
        trackUrl: `${config.baseUrl}/o/${order.id}`,
        note: 'Nothing has been charged. The buyer approves on PayPal; PayPal then holds the money and releases it to the seller only after the parcel photo is verified.',
      };
    }

    if (name === 'get_order_status') {
      const o = store.getOrder(String(args.order_id || ''));
      if (!o) return { error: 'Order not found.' };
      return orderView(o);
    }

    return { error: `Unknown tool: ${name}` };
  } catch (e) {
    return { error: e.message };
  }
}

export const tools = { definitions, run };

// Machine-readable description of the store for agents (served at /.well-known/agent-store.json).
export function manifest() {
  return {
    name: config.store.name,
    description: 'Agent-ready marketplace for small Nigerian sellers. Payments via PayPal; the human buyer always approves, and PayPal holds the money until AI verifies the parcel photo.',
    payments: {
      provider: 'PayPal', environment: 'sandbox', intent: 'AUTHORIZE', buyerApprovalRequired: true,
      escrow: 'Funds are authorized (held) on approval and captured only after proof of shipment is verified.',
      maxAgentOrderUsd: config.store.agentMaxOrderUsd,
    },
    negotiation: { tool: 'negotiate_price', note: "Prices on negotiable items can be haggled with the seller's agent. The seller's floor is private and enforced server-side." },
    http: {
      search: { method: 'GET', url: `${config.baseUrl}/api/agent/search?q={query}&max_price_usd={budget}` },
      product: { method: 'GET', url: `${config.baseUrl}/api/agent/products/{id}` },
      negotiate: { method: 'POST', url: `${config.baseUrl}/api/agent/negotiate`, body: { product_id: 'string', max_price_usd: 'number' } },
      checkout: { method: 'POST', url: `${config.baseUrl}/api/agent/checkout`, body: { product_id: 'string', quantity: 'integer', deal_id: 'string?' } },
      orderStatus: { method: 'GET', url: `${config.baseUrl}/api/agent/orders/{id}` },
    },
    mcp: { transport: 'stdio', command: 'npm run mcp', tools: definitions.map((d) => d.name) },
    tools: definitions.map(({ name, description, parameters }) => ({ name, description, parameters })),
  };
}
