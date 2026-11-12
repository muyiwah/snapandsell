import express from 'express';
import multer from 'multer';
import sharp from 'sharp';
import QRCode from 'qrcode';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { config, modes } from './config.js';
import * as store from './store.js';
import * as paypal from './paypal.js';
import * as ai from './ai.js';
import * as agentTools from './agentTools.js';
import * as escrow from './escrow.js';
import { seedIfEmpty } from './seed.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const uploadsDir = path.join(root, 'data', 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });

store.load();
seedIfEmpty();

export const app = express();
app.disable('x-powered-by');
// Behind Nginx: use X-Forwarded-For for the real client IP (rate limits are per IP).
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

// Simple per-IP rate limit for endpoints that cost money (AI calls, order creation).
const hits = new Map();
function limit(max, windowMs) {
  return (req, res, next) => {
    const key = `${req.path}|${req.ip}`;
    const now = Date.now();
    const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (list.length >= max) return res.status(429).json({ error: 'Too many requests. Please wait a minute and try again.' });
    list.push(now);
    hits.set(key, list);
    next();
  };
}

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((e) => {
    if (e instanceof z.ZodError) {
      const msg = e.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ');
      return res.status(400).json({ error: `Please check: ${msg}` });
    }
    if (!(e.status && e.status < 500)) console.error(e);
    res.status(e.status && e.status < 500 ? 400 : 500).json({ error: e.message || 'Something went wrong' });
  });

// ---------------- health & config ----------------
app.get('/api/health', wrap(async (_req, res) => {
  const [pp, model] = await Promise.all([paypal.healthCheck(), ai.healthCheck()]);
  res.json({ ok: pp.ok && model.ok, paypal: pp, ai: model, stats: store.stats() });
}));

app.get('/api/config', (_req, res) => {
  res.json({
    storeName: config.store.name,
    currency: config.paypal.currency,
    paypalClientId: modes.paypalMock ? null : config.paypal.clientId, // public by design
    modes,
    aiModel: modes.aiMock ? 'demo-mock' : config.ai.model,
  });
});

// ---------------- seller: photo → AI listing ----------------
app.post('/api/listings/draft', limit(12, 60_000), upload.single('photo'), wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Please attach a product photo.' });
  if (!/^image\//.test(req.file.mimetype)) return res.status(400).json({ error: 'That file is not an image.' });

  // Normalise: fix orientation, shrink (cheaper + faster for the model), strip metadata.
  const jpeg = await sharp(req.file.buffer).rotate().resize(1024, 1024, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
  const name = `${store.newId('img')}.jpg`;
  fs.writeFileSync(path.join(uploadsDir, name), jpeg);

  const notes = String(req.body?.notes || '').slice(0, 300);
  const started = Date.now();
  const draft = await ai.draftListing(jpeg, notes);
  res.json({ draft, image: `/uploads/${name}`, ms: Date.now() - started });
}));

const ProductInput = z.object({
  title: z.string().trim().min(3).max(90),
  description: z.string().trim().min(10).max(600),
  category: z.string().trim().max(40).default('Other'),
  condition: z.enum(['new', 'used', 'handmade']).default('new'),
  priceUsd: z.coerce.number().positive().max(10000),
  stock: z.coerce.number().int().min(1).max(999).default(1),
  tags: z.array(z.string().trim().max(30)).max(10).default([]),
  whatsappCaption: z.string().max(400).optional(),
  sellerName: z.string().trim().max(60).optional(),
  sellerCity: z.string().trim().max(60).optional(),
  image: z.string().regex(/^\/(uploads|seed)\/[\w.-]+$/).optional(),
  aiModel: z.string().max(60).optional(),
  negotiable: z.boolean().default(true),
  floorPriceUsd: z.coerce.number().positive().max(10000).optional(),
});

app.post('/api/products', wrap(async (req, res) => {
  const data = ProductInput.parse(req.body);
  data.priceUsd = Math.round(data.priceUsd * 100) / 100;
  if (data.floorPriceUsd != null) data.floorPriceUsd = Math.min(data.priceUsd, Math.round(data.floorPriceUsd * 100) / 100);
  const product = store.addProduct(data);
  res.status(201).json({ product, url: `${config.baseUrl}/p/${product.id}` });
}));

// Seller edits from the dashboard grid: price, private floor, haggling on/off, stock.
app.patch('/api/products/:id', limit(60, 60_000), wrap(async (req, res) => {
  const p = store.getProduct(req.params.id);
  if (!p) return res.status(404).json({ error: 'Product not found.' });
  const body = z.object({
    priceUsd: z.coerce.number().positive().max(10000).optional(),
    floorPriceUsd: z.coerce.number().positive().max(10000).optional(),
    negotiable: z.boolean().optional(),
    stock: z.coerce.number().int().min(0).max(999).optional(),
    status: z.enum(['active', 'removed']).optional(),
  }).parse(req.body);

  // Remove (hide) or restore a listing. Orders and their evidence are kept.
  if (body.status === 'removed') {
    const open = store.listOrders().filter((o) => o.productId === p.id && ['HELD', 'FLAGGED'].includes(o.status));
    if (open.length) {
      return res.status(409).json({ error: `PayPal is still holding money for ${open.length} order${open.length > 1 ? 's' : ''} of this item. Ship or cancel ${open.length > 1 ? 'them' : 'it'} first, then remove the listing.` });
    }
    const product = store.updateProduct(p.id, { status: 'removed', removedAt: new Date().toISOString() });
    store.logEvent('product_removed', { productId: p.id, title: p.title });
    return res.json({ product });
  }
  if (body.status === 'active' && p.status === 'removed') {
    const product = store.updateProduct(p.id, { status: p.stock > 0 ? 'active' : 'sold_out', removedAt: null });
    store.logEvent('product_restored', { productId: p.id, title: p.title });
    return res.json({ product });
  }
  if (p.status === 'removed') return res.status(400).json({ error: 'This listing is removed. Restore it before editing.' });
  const price = Math.round((body.priceUsd ?? p.priceUsd) * 100) / 100;
  const patch = { priceUsd: price };
  // The floor can never be above the list price.
  if (body.floorPriceUsd != null || p.floorPriceUsd != null) patch.floorPriceUsd = Math.min(price, Math.round((body.floorPriceUsd ?? p.floorPriceUsd) * 100) / 100);
  if (body.negotiable != null) patch.negotiable = body.negotiable;
  if (body.stock != null) {
    patch.stock = body.stock;
    if (body.stock === 0) patch.status = 'sold_out';
    else if (p.status === 'sold_out') patch.status = 'active';
  }
  const product = store.updateProduct(p.id, patch);
  store.logEvent('product_updated', { productId: p.id, title: p.title });
  res.json({ product });
}));

app.get('/api/products', (_req, res) => res.json({ products: store.listProducts().map(agentTools.publicProduct) }));

app.get('/api/products/:id', (req, res) => {
  const p = store.getProduct(req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  if (p.status === 'removed') return res.status(404).json({ error: 'The seller has removed this listing.' });
  res.json({ product: { ...agentTools.publicProduct(p), whatsappCaption: p.whatsappCaption, tags: p.tags, status: p.status, stock: p.stock } });
});

app.get('/api/products/:id/qr.png', wrap(async (req, res) => {
  const p = store.getProduct(req.params.id);
  if (!p) return res.status(404).end();
  const png = await QRCode.toBuffer(`${config.baseUrl}/p/${p.id}`, { width: 360, margin: 1 });
  res.type('png').send(png);
}));

// ---------------- buyer: PayPal checkout (money is held, not taken) ----------------
app.post('/api/orders', limit(20, 60_000), wrap(async (req, res) => {
  const { productId, quantity = 1, redirect = false } = z
    .object({ productId: z.string(), quantity: z.coerce.number().int().min(1).max(5).optional(), redirect: z.boolean().optional() })
    .parse(req.body);
  const p = store.getProduct(productId);
  if (!p || p.status !== 'active' || p.stock < quantity) return res.status(400).json({ error: 'This item is no longer available.' });

  const order = await paypal.createOrder({
    product: p,
    quantity,
    source: redirect ? 'qr' : 'web',
    returnUrl: redirect || modes.paypalMock ? `${config.baseUrl}/paypal/return` : undefined,
    cancelUrl: `${config.baseUrl}/p/${p.id}?cancelled=1`,
  });
  store.addOrder({
    id: order.id,
    productId: p.id,
    productTitle: p.title,
    quantity,
    amount: Math.round(p.priceUsd * quantity * 100) / 100,
    currency: config.paypal.currency,
    status: 'CREATED',
    channel: redirect ? 'qr-link' : 'web',
  });
  res.json({ id: order.id, approveUrl: order.approveUrl });
}));

/** After the buyer approves on PayPal: authorize (hold) the funds. */
async function authorizeAndRecord(orderId) {
  const local = store.getOrder(orderId);
  if (!local) throw Object.assign(new Error('Unknown order'), { status: 404 });
  if (local.status !== 'CREATED') return local;
  const result = await paypal.authorizeOrder(orderId);
  if (result.status !== 'COMPLETED' || !result.authorizationId) throw new Error(`Payment not authorized (status ${result.status}).`);
  return store.markOrderHeld(orderId, result);
}

app.post('/api/orders/:id/authorize', wrap(async (req, res) => {
  const order = await authorizeAndRecord(req.params.id);
  res.json({ order: agentTools.orderView(order) });
}));

// Return URL for redirect-based checkouts (AI agent links, QR codes).
app.get('/paypal/return', wrap(async (req, res) => {
  const orderId = String(req.query.token || '');
  try {
    await authorizeAndRecord(orderId);
    res.redirect(`/o/${encodeURIComponent(orderId)}?new=1`);
  } catch (e) {
    res.redirect(`/o/${encodeURIComponent(orderId)}?error=${encodeURIComponent(e.message)}`);
  }
}));

// Order tracker data (buyer view). Order ids are PayPal order ids; we show no payer email.
app.get('/api/orders/:id', (req, res) => {
  const o = store.getOrder(req.params.id);
  if (!o) return res.status(404).json({ error: 'Not found' });
  const p = store.getProduct(o.productId);
  res.json({
    order: {
      ...agentTools.orderView(o),
      productId: o.productId,
      productImage: p?.image || null,
      seller: p?.sellerName || null,
      sellerCity: p?.sellerCity || null,
      channel: o.channel,
      agentName: o.agentName || null,
      listAmount: o.listAmount || null,
      negotiated: Boolean(o.dealId),
      createdAt: o.createdAt,
      heldAt: o.heldAt || null,
      holdExpiresAt: o.holdExpiresAt || null,
      capturedAt: o.capturedAt || null,
      voidedAt: o.voidedAt || null,
      voidReason: o.voidReason || null,
      shipToCountry: o.shipTo?.countryCode || null,
      trackingAddedToPayPal: o.tracking?.addedToPayPal || false,
      verifications: (o.verifications || []).map(({ at, ms, image, listingImage, decision, reasons, check }) => ({ at, ms, image, listingImage, decision, reasons, check })),
    },
  });
});

// ---------------- seller: proof of shipment releases the money ----------------
const parcelUpload = upload.single('photo');
app.post('/api/orders/:id/ship', limit(10, 60_000), parcelUpload, wrap(async (req, res) => {
  let jpeg;
  if (req.file) {
    if (!/^image\//.test(req.file.mimetype)) return res.status(400).json({ error: 'That file is not an image.' });
    jpeg = await sharp(req.file.buffer).rotate().resize(1280, 1280, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
  } else if (['genuine', 'swap'].includes(req.body?.sample)) {
    jpeg = await escrow.sampleParcel(req.params.id, req.body.sample);
  } else {
    return res.status(400).json({ error: 'Please attach a photo of the packed parcel with its waybill.' });
  }
  const name = `${store.newId('parcel')}.jpg`;
  fs.writeFileSync(path.join(uploadsDir, name), jpeg);
  const result = await escrow.submitProof(req.params.id, jpeg, `/uploads/${name}`);
  res.json({ decision: result.verification.decision, reasons: result.verification.reasons, check: result.verification.check, ms: result.verification.ms, order: agentTools.orderView(result.order) });
}));

app.post('/api/orders/:id/cancel', limit(10, 60_000), wrap(async (req, res) => {
  const { by = 'buyer' } = z.object({ by: z.enum(['buyer', 'seller']).optional() }).parse(req.body || {});
  const order = await escrow.cancelHold(req.params.id, by === 'seller' ? 'Cancelled by the seller' : 'Cancelled by the buyer');
  res.json({ order: agentTools.orderView(order) });
}));

// ---------------- PayPal webhooks ----------------
app.post('/api/paypal/webhook', express.json({ limit: '256kb' }), wrap(async (req, res) => {
  const event = req.body || {};
  const ok = await paypal.verifyWebhook(req.headers, event).catch(() => false);
  if (!ok) return res.status(400).json({ error: 'Webhook signature not verified.' });
  const r = event.resource || {};
  const orderId = r.supplementary_data?.related_ids?.order_id || (event.event_type?.startsWith('CHECKOUT.ORDER') ? r.id : null);
  const order = orderId ? store.getOrder(orderId) : null;
  store.logEvent('webhook', { eventType: event.event_type, orderId: orderId || null, productTitle: order?.productTitle });
  if (order) {
    if (event.event_type === 'PAYMENT.CAPTURE.COMPLETED' && order.status !== 'PAID') store.markOrderPaid(order.id, { captureId: r.id });
    if (event.event_type === 'PAYMENT.AUTHORIZATION.VOIDED' && order.status !== 'VOIDED') store.markOrderVoided(order.id, 'Voided on PayPal');
    if (event.event_type === 'PAYMENT.CAPTURE.REFUNDED') store.updateOrder(order.id, { refunded: true }, 'order_refunded');
  }
  res.json({ received: true });
}));

// Local stand-in for PayPal's approval page, used only when no sandbox keys are set.
app.get('/mock-paypal', (req, res) => {
  if (!modes.paypalMock) return res.status(404).end();
  const token = String(req.query.token || '').replace(/[^\w-]/g, '');
  const o = store.getOrder(token);
  res.type('html').send(`<!doctype html><meta name=viewport content="width=device-width,initial-scale=1">
  <title>Mock PayPal</title><body style="font-family:system-ui;max-width:420px;margin:40px auto;padding:16px">
  <p style="background:#fff3cd;padding:10px;border-radius:8px">MOCK PayPal page: no sandbox keys are configured. Real PayPal sandbox is used when keys are set.</p>
  <h2>Approve payment</h2><p>${o ? `${o.productTitle}: $${o.amount}` : 'Unknown order'}</p><p style="color:#555">PayPal will hold the money until the seller proves shipment.</p>
  <a href="/paypal/return?token=${token}" style="display:inline-block;background:#0070ba;color:#fff;padding:12px 20px;border-radius:24px;text-decoration:none">Approve &amp; pay</a></body>`);
});

// ---------------- agent-ready store ----------------
app.get('/.well-known/agent-store.json', (_req, res) => res.json(agentTools.manifest()));

app.get('/api/agent/search', wrap(async (req, res) => {
  res.json(await agentTools.run('search_products', { query: req.query.q || '', max_price_usd: req.query.max_price_usd ? Number(req.query.max_price_usd) : undefined }));
}));

app.get('/api/agent/products/:id', wrap(async (req, res) => {
  res.json(await agentTools.run('get_product', { product_id: req.params.id }));
}));

app.post('/api/agent/checkout', limit(10, 60_000), wrap(async (req, res) => {
  const agentName = String(req.get('X-Agent-Name') || 'external agent');
  const result = await agentTools.run('start_checkout', req.body || {}, { agentName });
  res.status(result.error ? 400 : 200).json(result);
}));

app.post('/api/agent/negotiate', limit(6, 60_000), wrap(async (req, res) => {
  const agentName = String(req.get('X-Agent-Name') || 'external agent');
  const result = await agentTools.run('negotiate_price', req.body || {}, { agentName });
  res.status(result.error ? 400 : 200).json(result);
}));

app.get('/api/agent/orders/:id', wrap(async (req, res) => {
  const result = await agentTools.run('get_order_status', { order_id: req.params.id });
  res.status(result.error ? 404 : 200).json(result);
}));

// Built-in buyer agent (Muse Spark tool calling) for the demo.
// With "Accept: text/event-stream" it streams tool steps and the haggle live.
app.post('/api/agent/chat', limit(15, 60_000), wrap(async (req, res) => {
  const { messages } = z
    .object({ messages: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(2000) })).min(1).max(20) })
    .parse(req.body);
  const streaming = /text\/event-stream/.test(req.get('Accept') || '');
  const send = (type, data) => streaming && !res.writableEnded && res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  if (streaming) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write(': ok\n\n');
  }
  try {
    const result = await ai.runShoppingAgent(messages, {
      definitions: agentTools.definitions,
      run: (name, args) => agentTools.run(name, args, { agentName: 'Snap & Sell buyer agent (Muse Spark)', onEvent: (e) => send('haggle', e) }),
    }, { onStep: (step) => send('step', step) });
    if (!streaming) return res.json(result);
    send('done', result);
  } catch (e) {
    if (!streaming) throw e;
    console.error(e);
    send('error', { error: e.message || 'Something went wrong' });
  }
  res.end();
}));

// ---------------- seller dashboard ----------------
app.get('/api/dashboard', (_req, res) => {
  res.json({
    stats: store.stats(),
    products: store.listProducts({ includeHidden: true }),
    orders: store.listOrders(),
    events: store.listEvents(30),
  });
});

// ---------------- pages & static ----------------
const page = (file) => (_req, res) => res.sendFile(path.join(root, 'public', file));
app.get('/', page('index.html'));
app.get('/store', page('store.html'));
app.get('/p/:id', page('product.html'));
app.get('/dashboard', page('dashboard.html'));
// The agent now lives inside the Shop page; keep the old link working.
app.get('/agent', (_req, res) => res.redirect(301, '/store#agent'));
app.get('/orders', page('orders.html'));
app.get('/thanks', (req, res) => res.redirect(`/o/${encodeURIComponent(String(req.query.order || ''))}`));
app.get('/o/:id', page('order.html'));
app.use('/uploads', express.static(uploadsDir, { maxAge: '7d' }));
app.get('/vendor/ag-grid-community.min.js', (_req, res) =>
  res.sendFile(path.join(root, 'node_modules', 'ag-grid-community', 'dist', 'ag-grid-community.min.js')),
);
app.use(express.static(path.join(root, 'public'), { maxAge: '1h' }));

// Listen when run directly (`node src/server.js`) or under PM2 (whose wrapper is argv[1]);
// tests import `app` and listen themselves.
const runDirectly = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (runDirectly || process.env.pm_id !== undefined) {
  app.listen(config.port, () => {
    console.log(`${config.store.name} running at ${config.baseUrl}`);
    console.log(`PayPal: ${modes.paypalMock ? 'MOCK (set PAYPAL_CLIENT_ID/SECRET for sandbox)' : 'sandbox'} · AI: ${modes.aiMock ? 'MOCK (set META_API_KEY)' : config.ai.model}`);
  });
}
