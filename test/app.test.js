// End-to-end tests. A fake upstream imitates PayPal (Orders v2, Payments v2 authorizations,
// tracking, webhook verification) and Meta's Responses API, so the real (non-mock)
// integration code runs and we can check the exact requests the app sends.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

const seen = [];
let nextShipment = 'genuine';
let orderSeq = 0;

const out = (obj) => ({ output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(obj) }] }], usage: { input_tokens: 10, output_tokens: 10 } });

const upstream = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    seen.push({ method: req.method, url: req.url, headers: req.headers, body });
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(obj === undefined ? '' : JSON.stringify(obj)); };
    const u = req.url;
    if (u === '/v1/oauth2/token') return send(200, { access_token: 'TEST_TOKEN', expires_in: 3600 });
    if (u === '/v2/checkout/orders' && req.method === 'POST') {
      const b = JSON.parse(body);
      const id = `ORDER${++orderSeq}`;
      return send(201, {
        id, status: b.payment_source ? 'PAYER_ACTION_REQUIRED' : 'CREATED',
        links: [{ rel: b.payment_source ? 'payer-action' : 'approve', href: `https://www.sandbox.paypal.com/checkoutnow?token=${id}` }],
      });
    }
    let m;
    if ((m = u.match(/^\/v2\/checkout\/orders\/(\w+)\/authorize$/))) {
      return send(201, {
        id: m[1], status: 'COMPLETED', payer: { email_address: 'buyer@example.com' },
        purchase_units: [{ shipping: { name: { full_name: 'Sarah Jones' }, address: { country_code: 'GB', admin_area_2: 'London' } }, payments: { authorizations: [{ id: `AUTH-${m[1]}`, status: 'CREATED', expiration_time: '2026-12-10T00:00:00Z' }] } }],
      });
    }
    if ((m = u.match(/^\/v2\/payments\/authorizations\/([\w-]+)\/capture$/))) return send(201, { id: `CAP-${m[1]}`, status: 'COMPLETED' });
    if ((m = u.match(/^\/v2\/payments\/authorizations\/([\w-]+)\/void$/))) return send(204);
    if ((m = u.match(/^\/v2\/checkout\/orders\/(\w+)\/track$/))) return send(201, { id: m[1] });
    if (u === '/v1/notifications/verify-webhook-signature') {
      return send(200, { verification_status: JSON.parse(body).transmission_sig === 'good' ? 'SUCCESS' : 'FAILURE' });
    }
    if (u === '/meta/responses') {
      const b = JSON.parse(body);
      const name = b.text?.format?.name;
      if (name === 'listing') {
        return send(200, out({ title: 'Hand-dyed Indigo Scarf', description: 'A long cotton scarf hand-dyed in deep indigo.', category: 'Fashion', condition: 'handmade', priceUsd: 28, priceReasoning: 'Similar scarves sell for $20-35.', tags: ['scarf', 'indigo'], whatsappCaption: 'New scarf in!', confidence: 0.86 }));
      }
      if (name === 'shipment_check') {
        const swap = nextShipment === 'swap';
        return send(200, out({
          sameItem: !swap, confidence: 0.95, matchingDetails: swap ? [] : ['same buckle'], differences: swap ? ['different pattern'] : [],
          waybillVisible: true, trackingNumber: 'GIG-12345678', carrier: 'GIG Logistics', recipientName: 'Sarah Jones', recipientCountry: 'GB', recipientMatches: true,
          summary: swap ? 'Different item.' : 'Same item.',
        }));
      }
      // Seller tries to go below the floor ($31) and buyer tries to exceed the budget: the server must clamp both.
      if (name === 'buyer_turn') return send(200, out({ message: 'How about this?', offerUsd: 99, accept: false }));
      if (name === 'seller_turn') return send(200, out({ message: 'Okay, cheap for you.', offerUsd: 5, accept: false }));
      if (b.tools) {
        const hadTool = b.input.some((i) => i.type === 'function_call_output');
        if (!hadTool) return send(200, { output: [{ type: 'function_call', call_id: 'c1', name: 'search_products', arguments: JSON.stringify({ query: 'spice' }) }] });
        return send(200, out('x') && { output: [{ type: 'message', content: [{ type: 'output_text', text: 'I found the suya spice mix for $12.' }] }] });
      }
      return send(200, out({ ok: true }));
    }
    send(404, { message: 'not found' });
  });
});

let base;
let app;
let server;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'snapsell-'));

before(async () => {
  await new Promise((r) => upstream.listen(0, r));
  const up = `http://127.0.0.1:${upstream.address().port}`;
  Object.assign(process.env, {
    PAYPAL_CLIENT_ID: 'cid', PAYPAL_CLIENT_SECRET: 'secret', PAYPAL_API_BASE: up, PAYPAL_WEBHOOK_ID: 'WH1',
    META_API_KEY: 'mk', META_BASE_URL: `${up}/meta`, DATA_FILE: path.join(tmp, 'db.json'), AGENT_MAX_ORDER_USD: '40', AI_LOG: 'false',
  });
  ({ app } = await import('../src/server.js'));
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  process.env.PUBLIC_BASE_URL = base;
});

after(() => { server?.close(); upstream.close(); });

const json = async (p, opts = {}) => {
  const res = await fetch(base + p, { ...opts, redirect: 'manual', headers: { ...(opts.body && !(opts.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) } });
  const text = await res.text();
  const isJson = /json/.test(res.headers.get('content-type') || '');
  return { status: res.status, body: text && isJson ? JSON.parse(text) : text || null, headers: res.headers };
};
const product = async (re) => (await json('/api/products')).body.products.find((p) => re.test(p.title));
const lastReq = (re) => seen.findLast((s) => re.test(s.url));

test('config reports live (non-mock) modes', async () => {
  const { body } = await json('/api/config');
  assert.equal(body.modes.paypalMock, false);
  assert.equal(body.modes.aiMock, false);
  assert.equal(body.paypalClientId, 'cid');
});

test('photo -> AI listing uses the Muse Spark Responses API with an image and a strict schema', async () => {
  const img = await sharp({ create: { width: 1600, height: 1200, channels: 3, background: '#1d3b6e' } }).jpeg().toBuffer();
  const fd = new FormData();
  fd.append('photo', new Blob([img], { type: 'image/jpeg' }), 'p.jpg');
  fd.append('notes', 'cotton, 180cm');
  const res = await fetch(base + '/api/listings/draft', { method: 'POST', body: fd });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.draft.title, 'Hand-dyed Indigo Scarf');
  const call = lastReq(/\/meta\/responses$/);
  assert.equal(call.headers.authorization, 'Bearer mk');
  const sent = JSON.parse(call.body);
  assert.equal(sent.model, 'muse-spark-1.3');
  assert.equal(sent.text.format.type, 'json_schema');
  assert.equal(sent.text.format.strict, true);
  assert.ok(sent.input[0].content.find((p) => p.type === 'input_image').image_url.startsWith('data:image/jpeg;base64,'));
  const meta = await sharp(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'data', 'uploads', path.basename(body.image))).metadata();
  assert.ok(meta.width <= 1024, 'image shrunk before sending');
});

test('button checkout uses intent AUTHORIZE; approval holds the money (no capture yet)', async () => {
  const spice = await product(/Suya/);
  const created = await json('/api/orders', { method: 'POST', body: JSON.stringify({ productId: spice.id }) });
  assert.equal(created.status, 200);
  const req = JSON.parse(lastReq(/^\/v2\/checkout\/orders$/).body);
  assert.equal(req.intent, 'AUTHORIZE');
  assert.equal(req.purchase_units[0].amount.value, '12.00');
  assert.equal(req.payment_source, undefined, 'JS SDK flow must not send a return URL');

  const auth = await json(`/api/orders/${created.body.id}/authorize`, { method: 'POST' });
  assert.equal(auth.status, 200, JSON.stringify(auth.body));
  assert.equal(auth.body.order.status, 'HELD');
  assert.ok(!seen.some((s) => /\/capture$/.test(s.url)), 'nothing captured on approval');
});

test('haggle: the server clamps both agents (seller never below floor, buyer never above budget)', async () => {
  const tote = await product(/Buckle/); // list $38, private floor $31
  const r = await json('/api/agent/negotiate', { method: 'POST', body: JSON.stringify({ product_id: tote.id, max_price_usd: 34 }) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  for (const m of r.body.transcript) {
    if (m.side === 'buyer') assert.ok(m.offerUsd <= 34, `buyer offered ${m.offerUsd} above budget`);
    if (m.side === 'seller') assert.ok(m.offerUsd >= 31, `seller went to ${m.offerUsd}, below floor`);
  }
  assert.equal(r.body.agreed, true);
  assert.ok(r.body.priceUsd >= 31 && r.body.priceUsd <= 34);
  assert.ok(!JSON.stringify(r.body).includes('floor'), 'floor never leaks to the buyer side');
  const prompts = seen.filter((s) => /\/meta\/responses$/.test(s.url)).map((s) => JSON.parse(s.body)).filter((b) => b.text?.format?.name === 'buyer_turn');
  assert.ok(prompts.every((b) => !JSON.stringify(b).includes('31')), "the buyer's agent never sees the seller's floor");
});

test('agent checkout with a deal: negotiated price, redirect flow, deal used once, spending cap', async () => {
  const tote = await product(/Buckle/);
  const deal = (await json('/api/agent/negotiate', { method: 'POST', body: JSON.stringify({ product_id: tote.id, max_price_usd: 34 }) })).body;
  const ok = await json('/api/agent/checkout', { method: 'POST', body: JSON.stringify({ product_id: tote.id, deal_id: deal.dealId }) });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.total, deal.priceUsd);
  assert.match(ok.body.approveUrl, /sandbox\.paypal\.com/);
  const req = JSON.parse(lastReq(/^\/v2\/checkout\/orders$/).body);
  assert.equal(req.intent, 'AUTHORIZE');
  assert.equal(Number(req.purchase_units[0].amount.value), deal.priceUsd);
  assert.match(req.payment_source.paypal.experience_context.return_url, /\/paypal\/return$/);

  const reuse = await json('/api/agent/checkout', { method: 'POST', body: JSON.stringify({ product_id: tote.id, deal_id: deal.dealId }) });
  assert.equal(reuse.status, 400);
  assert.match(reuse.body.error, /already used/);

  const adire = await product(/Adire/); // $65, above the $40 test cap
  const capped = await json('/api/agent/checkout', { method: 'POST', body: JSON.stringify({ product_id: adire.id }) });
  assert.equal(capped.status, 400);
  assert.match(capped.body.error, /capped/);
});

async function heldOrder() {
  const tote = await product(/Buckle/);
  const c = await json('/api/agent/checkout', { method: 'POST', body: JSON.stringify({ product_id: tote.id }) });
  const ret = await json(`/paypal/return?token=${c.body.orderId}`);
  assert.equal(ret.status, 302);
  assert.match(ret.headers.get('location'), new RegExp(`/o/${c.body.orderId}`));
  return c.body.orderId;
}

test('proof of shipment: a swapped item is flagged and the money stays held', async () => {
  const id = await heldOrder();
  nextShipment = 'swap';
  const r = await json(`/api/orders/${id}/ship`, { method: 'POST', body: JSON.stringify({ sample: 'swap' }) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.decision, 'reject');
  assert.equal(r.body.order.status, 'FLAGGED');
  assert.ok(!seen.some((s) => s.url === `/v2/payments/authorizations/AUTH-${id}/capture`), 'no capture on a swap');
  const sent = JSON.parse(lastReq(/\/meta\/responses$/).body);
  assert.equal(sent.input[0].content.filter((p) => p.type === 'input_image').length, 2, 'listing + parcel photo sent');
  assert.match(JSON.stringify(sent), /Sarah Jones/, 'expected recipient from PayPal shipping sent to the check');

  // Buyer cancels: authorization voided, buyer not charged.
  const c = await json(`/api/orders/${id}/cancel`, { method: 'POST', body: JSON.stringify({ by: 'buyer' }) });
  assert.equal(c.body.order.status, 'VOIDED');
  assert.ok(seen.some((s) => s.url === `/v2/payments/authorizations/AUTH-${id}/void`));
});

test('proof of shipment: the genuine item releases the money and adds tracking to PayPal', async () => {
  const id = await heldOrder();
  nextShipment = 'genuine';
  const r = await json(`/api/orders/${id}/ship`, { method: 'POST', body: JSON.stringify({ sample: 'genuine' }) });
  assert.equal(r.body.decision, 'release', JSON.stringify(r.body));
  assert.equal(r.body.order.status, 'PAID');
  assert.equal(r.body.order.trackingNumber, 'GIG-12345678');
  const cap = seen.find((s) => s.url === `/v2/payments/authorizations/AUTH-${id}/capture`);
  assert.ok(cap, 'authorization captured');
  assert.equal(JSON.parse(cap.body).final_capture, true);
  const track = JSON.parse(seen.find((s) => s.url === `/v2/checkout/orders/${id}/track`).body);
  assert.equal(track.tracking_number, 'GIG-12345678');
  assert.equal(track.carrier, 'OTHER');
  assert.equal(track.capture_id, `CAP-AUTH-${id}`);

  const again = await json(`/api/orders/${id}/ship`, { method: 'POST', body: JSON.stringify({ sample: 'genuine' }) });
  assert.equal(again.status, 400, 'cannot release twice');
});

test('release rules live in code: low confidence or no waybill keeps the money held', async () => {
  const { decide } = await import('../src/escrow.js');
  const base = { sameItem: true, confidence: 0.95, waybillVisible: true, trackingNumber: 'X1', recipientMatches: true };
  assert.equal(decide(base).decision, 'release');
  assert.equal(decide({ ...base, confidence: 0.6 }).decision, 'hold');
  assert.equal(decide({ ...base, trackingNumber: null }).decision, 'hold');
  assert.equal(decide({ ...base, recipientMatches: false }).decision, 'hold');
  assert.equal(decide({ ...base, sameItem: false, confidence: 0.9 }).decision, 'reject');
});

test('buyer agent runs a Muse Spark tool-calling loop over the Responses API', async () => {
  const { status, body } = await json('/api/agent/chat', { method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: 'something spicy' }] }) });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.steps[0].tool, 'search_products');
  assert.ok(body.steps[0].result.products.some((p) => /Suya/.test(p.title)));
  assert.match(body.reply, /suya/i);
  const final = JSON.parse(lastReq(/\/meta\/responses$/).body);
  assert.ok(final.input.some((i) => i.type === 'function_call_output' && i.call_id === 'c1'), 'tool result is sent back to the model');
  assert.ok(final.tools.some((t) => t.name === 'negotiate_price'));
});

test('webhooks: only verified events are accepted', async () => {
  const bad = await json('/api/paypal/webhook', { method: 'POST', headers: { 'paypal-transmission-sig': 'bad' }, body: JSON.stringify({ event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: {} }) });
  assert.equal(bad.status, 400);
  const good = await json('/api/paypal/webhook', { method: 'POST', headers: { 'paypal-transmission-sig': 'good' }, body: JSON.stringify({ event_type: 'PAYMENT.AUTHORIZATION.CREATED', resource: { id: 'A1' } }) });
  assert.equal(good.status, 200);
  const v = JSON.parse(lastReq(/verify-webhook-signature/).body);
  assert.equal(v.webhook_id, 'WH1');
});

test('agent manifest lists the tools and the escrow rules', async () => {
  const m = await json('/.well-known/agent-store.json');
  assert.deepEqual(m.body.mcp.tools, ['search_products', 'get_product', 'negotiate_price', 'start_checkout', 'get_order_status']);
  assert.equal(m.body.payments.intent, 'AUTHORIZE');
  assert.equal(m.body.payments.buyerApprovalRequired, true);
  const s = await json('/api/agent/search?q=adire%20cloth');
  assert.ok(s.body.products[0].title.includes('Adire'));
  assert.ok(!('floorPriceUsd' in s.body.products[0]), 'floor price never public');
});

test('seller edits from the grid: floor capped at price, stock 0 marks sold out, floor stays private', async () => {
  const pouch = await product(/Crossbody/);
  const r = await json(`/api/products/${pouch.id}`, { method: 'PATCH', body: JSON.stringify({ priceUsd: 20, floorPriceUsd: 25, negotiable: true }) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.product.priceUsd, 20);
  assert.equal(r.body.product.floorPriceUsd, 20, 'floor capped at list price');
  const sold = await json(`/api/products/${pouch.id}`, { method: 'PATCH', body: JSON.stringify({ stock: 0 }) });
  assert.equal(sold.body.product.status, 'sold_out');
  const back = await json(`/api/products/${pouch.id}`, { method: 'PATCH', body: JSON.stringify({ stock: 3 }) });
  assert.equal(back.body.product.status, 'active');
  const pub = await json(`/api/products/${pouch.id}`);
  assert.ok(!JSON.stringify(pub.body).includes('floorPriceUsd'), 'floor not in the public product API');
  const bad = await json(`/api/products/${pouch.id}`, { method: 'PATCH', body: JSON.stringify({ priceUsd: -5 }) });
  assert.equal(bad.status, 400);
});

test('remove a listing: blocked while money is held, then hidden everywhere, then restored', async () => {
  const choker = await product(/Choker/);
  // A held order for this item blocks removal.
  const c = await json('/api/orders', { method: 'POST', body: JSON.stringify({ productId: choker.id, redirect: true }) });
  c.body.orderId = c.body.id;
  await json(`/paypal/return?token=${c.body.orderId}`);
  const blocked = await json(`/api/products/${choker.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'removed' }) });
  assert.equal(blocked.status, 409);
  assert.match(blocked.body.error, /still holding money/);
  await json(`/api/orders/${c.body.orderId}/cancel`, { method: 'POST', body: JSON.stringify({ by: 'seller' }) });

  const removed = await json(`/api/products/${choker.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'removed' }) });
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.equal(removed.body.product.status, 'removed');
  assert.equal((await json(`/api/products/${choker.id}`)).status, 404, 'public product page gone');
  assert.ok(!(await json('/api/products')).body.products.some((p) => p.id === choker.id), 'not in the store');
  assert.ok(!(await json('/api/agent/search?q=choker')).body.products.length, 'not found by agents');
  const buy = await json('/api/agent/checkout', { method: 'POST', body: JSON.stringify({ product_id: choker.id }) });
  assert.equal(buy.status, 400, 'agents cannot buy it');
  const edit = await json(`/api/products/${choker.id}`, { method: 'PATCH', body: JSON.stringify({ priceUsd: 40 }) });
  assert.equal(edit.status, 400, 'no edits while removed');
  assert.ok((await json('/api/dashboard')).body.products.some((p) => p.id === choker.id), 'still listed for the seller');

  const restored = await json(`/api/products/${choker.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'active' }) });
  assert.equal(restored.body.product.status, 'active');
  assert.equal((await json(`/api/products/${choker.id}`)).status, 200);
});

test('bad input gets a friendly 400', async () => {
  const r = await json('/api/products', { method: 'POST', body: JSON.stringify({ title: 'x' }) });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /^Please check:/);
});
