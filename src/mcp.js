#!/usr/bin/env node
// MCP server: lets any MCP client (Claude Desktop, Cursor, other agents) shop the
// Snap & Sell store. It calls the store's public agent HTTP API, so it works against
// localhost or the deployed URL. Set SNAP_SELL_URL to point it at a store.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const BASE = (process.env.SNAP_SELL_URL || 'http://localhost:3000').replace(/\/$/, '');

async function call(path, init) {
  const res = await fetch(BASE + path, { ...init, headers: { 'Content-Type': 'application/json', 'X-Agent-Name': 'MCP client', ...(init?.headers || {}) } });
  const json = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  return { content: [{ type: 'text', text: JSON.stringify(json, null, 2) }], isError: !res.ok };
}

const server = new McpServer({ name: 'snap-and-sell', version: '2.0.0' });

server.registerTool(
  'search_products',
  {
    description: 'Search products from small Nigerian sellers on Snap & Sell. Returns up to 5 in-stock matches with USD prices.',
    inputSchema: { query: z.string().describe('What the buyer wants'), max_price_usd: z.number().optional().describe('Budget per item in USD') },
  },
  async ({ query, max_price_usd }) => {
    const qs = new URLSearchParams({ q: query });
    if (max_price_usd != null) qs.set('max_price_usd', String(max_price_usd));
    return call(`/api/agent/search?${qs}`);
  },
);

server.registerTool(
  'get_product',
  { description: 'Get details for one product by id.', inputSchema: { product_id: z.string() } },
  async ({ product_id }) => call(`/api/agent/products/${encodeURIComponent(product_id)}`),
);

server.registerTool(
  'negotiate_price',
  {
    description: "Haggle with the seller's AI agent for a better price, within the buyer's budget. Returns an agreed price and a deal_id for start_checkout, or no deal. The seller's lowest price is private and enforced by the store.",
    inputSchema: { product_id: z.string(), max_price_usd: z.number().positive().describe('Most the buyer will pay for one unit') },
  },
  async ({ product_id, max_price_usd }) => call('/api/agent/negotiate', { method: 'POST', body: JSON.stringify({ product_id, max_price_usd }) }),
);

server.registerTool(
  'start_checkout',
  {
    description: 'Create a PayPal checkout for a chosen product. Does NOT charge anyone: returns a link the human buyer must open and approve on PayPal. PayPal then holds the money until the seller proves shipment. Pass deal_id to use a negotiated price.',
    inputSchema: { product_id: z.string(), quantity: z.number().int().min(1).max(5).optional(), deal_id: z.string().optional() },
  },
  async ({ product_id, quantity, deal_id }) => call('/api/agent/checkout', { method: 'POST', body: JSON.stringify({ product_id, quantity, deal_id }) }),
);

server.registerTool(
  'get_order_status',
  { description: 'Check an order: money held, parcel verified, money released, tracking number.', inputSchema: { order_id: z.string() } },
  async ({ order_id }) => call(`/api/agent/orders/${encodeURIComponent(order_id)}`),
);

await server.connect(new StdioServerTransport());
