// Tiny JSON-file data store. Good enough for a hackathon demo; swap for MongoDB later.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';

const file = path.resolve(config.store.dataFile);
let db = { products: [], orders: [], events: [], deals: [] };

export function load() {
  if (fs.existsSync(file)) {
    db = JSON.parse(fs.readFileSync(file, 'utf8'));
    db.products ??= [];
    db.orders ??= [];
    db.events ??= [];
    db.deals ??= [];
  }
  return db;
}

function save() {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, file);
}

export const newId = (prefix) => `${prefix}_${crypto.randomBytes(5).toString('hex')}`;

// ---------- products ----------
export function listProducts({ includeHidden = false } = {}) {
  return db.products.filter((p) => includeHidden || p.status === 'active');
}

export function getProduct(id) {
  return db.products.find((p) => p.id === id) || null;
}

export function addProduct(data) {
  const product = {
    id: newId('prd'),
    status: 'active',
    stock: 1,
    createdAt: new Date().toISOString(),
    ...data,
  };
  db.products.unshift(product);
  logEvent('product_listed', { productId: product.id, title: product.title });
  save();
  return product;
}

export function updateProduct(id, patch) {
  const p = getProduct(id);
  if (!p) return null;
  Object.assign(p, patch, { updatedAt: new Date().toISOString() });
  save();
  return p;
}

const STOPWORDS = new Set('a an the i im me my we want need looking for find some something any under below over less than with and or to of in on is it gift buy get show please can you usd dollars'.split(' '));

// Keyword search used by both the storefront and AI shopping agents.
export function searchProducts({ query = '', maxPriceUsd, limit = 5 } = {}) {
  const terms = String(query)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
    .map((t) => (t.length > 3 && t.endsWith('s') ? t.slice(0, -1) : t));
  const scored = listProducts()
    .filter((p) => p.stock > 0)
    .filter((p) => maxPriceUsd == null || p.priceUsd <= Number(maxPriceUsd))
    .map((p) => {
      const hay = [p.title, p.description, p.category, ...(p.tags || [])].join(' ').toLowerCase();
      const score = terms.length ? terms.reduce((s, t) => s + (hay.includes(t) ? 1 : 0), 0) : 1;
      return { p, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((x) => x.p);
}

// ---------- orders ----------
export function addOrder(order) {
  db.orders.unshift({ createdAt: new Date().toISOString(), ...order });
  logEvent('order_created', { orderId: order.id, channel: order.channel, amount: order.amount });
  save();
  return order;
}

export function getOrder(id) {
  return db.orders.find((o) => o.id === id) || null;
}

export function listOrders() {
  return db.orders;
}

/*
 * Order lifecycle (escrow-style, with PayPal holding the money):
 *   CREATED  -> buyer has not approved yet
 *   HELD     -> buyer approved, PayPal authorization holds the funds
 *   FLAGGED  -> seller's parcel photo did not pass the check; funds still held
 *   PAID     -> parcel verified, authorization captured, money released to seller
 *   VOIDED   -> hold cancelled, buyer never charged
 */
export function updateOrder(id, patch, event) {
  const o = getOrder(id);
  if (!o) return null;
  Object.assign(o, patch, { updatedAt: new Date().toISOString() });
  if (event) logEvent(event, { orderId: id, amount: o.amount, channel: o.channel, productTitle: o.productTitle });
  save();
  return o;
}

export function markOrderHeld(id, { payerEmail, authorizationId, shipTo, expiresAt } = {}) {
  const o = getOrder(id);
  if (!o) return null;
  if (o.status !== 'CREATED') return o;
  const p = getProduct(o.productId);
  if (p) {
    p.stock = Math.max(0, (p.stock || 0) - (o.quantity || 1));
    if (p.stock === 0) p.status = 'sold_out';
  }
  return updateOrder(id, { status: 'HELD', heldAt: new Date().toISOString(), payerEmail: payerEmail || null, authorizationId, shipTo: shipTo || null, holdExpiresAt: expiresAt || null }, 'order_held');
}

export function addVerification(id, v) {
  const o = getOrder(id);
  if (!o) return null;
  o.verifications ??= [];
  o.verifications.unshift(v);
  logEvent(v.decision === 'release' ? 'parcel_verified' : 'parcel_flagged', { orderId: id, amount: o.amount, productTitle: o.productTitle, decision: v.decision });
  save();
  return o;
}

export function markOrderPaid(id, { captureId } = {}) {
  const o = getOrder(id);
  if (!o || o.status === 'PAID') return o;
  return updateOrder(id, { status: 'PAID', capturedAt: new Date().toISOString(), captureId: captureId || null }, 'order_paid');
}

export function markOrderVoided(id, reason) {
  const o = getOrder(id);
  if (!o || o.status === 'VOIDED') return o;
  const p = getProduct(o.productId);
  if (p && o.status !== 'CREATED') {
    p.stock = (p.stock || 0) + (o.quantity || 1);
    if (p.status === 'sold_out') p.status = 'active';
  }
  return updateOrder(id, { status: 'VOIDED', voidedAt: new Date().toISOString(), voidReason: reason || null }, 'order_voided');
}

// ---------- deals (prices agreed by haggling agents) ----------
export function addDeal(deal) {
  const d = { id: newId('deal'), createdAt: new Date().toISOString(), used: false, ...deal };
  db.deals.unshift(d);
  db.deals = db.deals.slice(0, 500);
  logEvent('deal_agreed', { dealId: d.id, productTitle: d.productTitle, amount: d.priceUsd, listPriceUsd: d.listPriceUsd });
  save();
  return d;
}

export function getDeal(id) {
  return db.deals.find((d) => d.id === id) || null;
}

/** Most recent unused, unexpired deal for a product made by this agent. */
export function findOpenDeal(productId, agentName) {
  const now = Date.now();
  return db.deals.find((d) => d.productId === productId && !d.used && d.agentName === agentName && Date.parse(d.expiresAt) > now) || null;
}

export function useDeal(id) {
  const d = getDeal(id);
  if (d) {
    d.used = true;
    save();
  }
  return d;
}

// ---------- events (append-only activity feed) ----------
export function logEvent(type, data) {
  db.events.unshift({ type, at: new Date().toISOString(), ...data });
  db.events = db.events.slice(0, 500);
}

export function listEvents(limit = 50) {
  return db.events.slice(0, limit);
}

export function stats() {
  const sum = (list) => Math.round(list.reduce((s, o) => s + Number(o.amount || 0), 0) * 100) / 100;
  const paid = db.orders.filter((o) => o.status === 'PAID');
  const held = db.orders.filter((o) => o.status === 'HELD' || o.status === 'FLAGGED');
  return {
    products: listProducts().length,
    orders: db.orders.length,
    paidOrders: paid.length,
    revenueUsd: sum(paid),
    heldOrders: held.length,
    heldUsd: sum(held),
    agentOrders: db.orders.filter((o) => o.channel === 'ai-agent').length,
    agentRevenueUsd: sum(paid.filter((o) => o.channel === 'ai-agent')),
    deals: db.deals.length,
    blockedSwaps: db.orders.filter((o) => (o.verifications || []).some((v) => v.decision === 'reject')).length,
  };
}

// Testing helper
export function _reset(data = { products: [], orders: [], events: [], deals: [] }) {
  db = structuredClone(data);
  save();
}
