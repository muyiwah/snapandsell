// Proof-of-shipment escrow. PayPal holds the buyer's money (an authorization).
// The seller photographs the packed parcel; Muse Spark compares it with the listing
// photo and reads the waybill; the rules below (code, not the model) decide whether
// to release the money (capture), keep holding it, or flag a likely swap.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import * as store from './store.js';
import * as paypal from './paypal.js';
import * as ai from './ai.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const uploadsDir = path.join(root, 'data', 'uploads');

/** Resolve a product image path (/uploads/x.jpg or /seed/x.jpg) to a JPEG buffer. */
export async function loadImageJpeg(webPath) {
  if (!webPath || !/^\/(uploads|seed)\/[\w.-]+$/.test(webPath)) return null;
  const file = webPath.startsWith('/uploads/') ? path.join(uploadsDir, path.basename(webPath)) : path.join(root, 'public', 'seed', path.basename(webPath));
  if (!fs.existsSync(file)) return null;
  return sharp(file).rotate().resize(1024, 1024, { fit: 'inside', withoutEnlargement: true }).flatten({ background: '#ffffff' }).jpeg({ quality: 82 }).toBuffer();
}

export const RULES = { releaseConfidence: 0.8, rejectConfidence: 0.7 };

/**
 * Decide what happens to the held money. The model only reports what it sees;
 * this function makes the money decision.
 * @returns {{decision: 'release'|'hold'|'reject', reasons: string[]}}
 */
export function decide(check) {
  const reasons = [];
  if (!check.sameItem && check.confidence >= RULES.rejectConfidence) {
    return { decision: 'reject', reasons: ['The parcel shows a different item from the one the buyer paid for.'] };
  }
  if (!check.sameItem) reasons.push('Not sure the parcel shows the same item.');
  if (check.sameItem && check.confidence < RULES.releaseConfidence) reasons.push('The match is not certain enough. Take a clearer photo in good light.');
  if (!check.waybillVisible || !check.trackingNumber) reasons.push('No readable waybill or tracking number in the photo.');
  if (check.recipientMatches === false) reasons.push("The waybill's recipient does not match the buyer's PayPal shipping details.");
  return reasons.length ? { decision: 'hold', reasons } : { decision: 'release', reasons: ['Same item as the listing, with a readable waybill.'] };
}

/**
 * Run the full proof-of-shipment step for an order.
 * @param {string} orderId
 * @param {Buffer} parcelJpeg normalised JPEG of the parcel photo
 * @param {string} parcelWebPath where the parcel photo was saved (for the buyer's evidence view)
 */
export async function submitProof(orderId, parcelJpeg, parcelWebPath) {
  const order = store.getOrder(orderId);
  if (!order) throw Object.assign(new Error('Order not found.'), { status: 404 });
  if (!['HELD', 'FLAGGED'].includes(order.status)) {
    throw Object.assign(new Error(order.status === 'PAID' ? 'This order is already paid out.' : 'This order has no payment on hold yet.'), { status: 400 });
  }
  const product = store.getProduct(order.productId);
  const listingJpeg = await loadImageJpeg(product?.image);
  if (!listingJpeg) throw Object.assign(new Error('The listing photo is missing, so the parcel cannot be compared.'), { status: 400 });

  const started = Date.now();
  const check = await ai.verifyShipment({ listingJpeg, shipmentJpeg: parcelJpeg, productTitle: order.productTitle, expected: order.shipTo || {} });
  const { decision, reasons } = decide(check);
  const v = { at: new Date().toISOString(), ms: Date.now() - started, image: parcelWebPath, listingImage: product.image, decision, reasons, check };
  store.addVerification(orderId, v);

  if (decision === 'release') {
    const cap = await paypal.captureAuthorization(order.authorizationId, { invoiceId: order.id, note: `Shipped: ${check.carrier || 'courier'} ${check.trackingNumber}` });
    if (cap.status !== 'COMPLETED' && cap.status !== 'PENDING') throw new Error(`PayPal capture returned ${cap.status}.`);
    const tracking = { trackingNumber: check.trackingNumber, carrier: check.carrier || 'Courier', addedToPayPal: false };
    try {
      await paypal.addTracking(order.id, { captureId: cap.captureId, trackingNumber: check.trackingNumber, carrier: check.carrier });
      tracking.addedToPayPal = true;
    } catch (e) {
      tracking.error = e.message;
    }
    store.updateOrder(orderId, { tracking });
    store.markOrderPaid(orderId, { captureId: cap.captureId });
  } else {
    store.updateOrder(orderId, { status: 'FLAGGED' }, 'order_flagged');
  }
  return { order: store.getOrder(orderId), verification: v };
}

/** Buyer or seller cancels a held order: void the authorization, nobody is charged. */
export async function cancelHold(orderId, reason) {
  const order = store.getOrder(orderId);
  if (!order) throw Object.assign(new Error('Order not found.'), { status: 404 });
  if (!['HELD', 'FLAGGED'].includes(order.status)) throw Object.assign(new Error('Only held orders can be cancelled.'), { status: 400 });
  await paypal.voidAuthorization(order.authorizationId);
  return store.markOrderVoided(orderId, reason);
}

// ---------------- sample parcel photos (so judges can test without shipping) ----------------

const escXml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);

function waybillSvg({ tracking, name, country, from }) {
  const bars = Array.from({ length: 28 }, (_, i) => `<rect x="${18 + i * 11.5}" y="150" width="${(i * 7) % 3 === 0 ? 7 : 3}" height="46" fill="#111"/>`).join('');
  return Buffer.from(`<svg width="380" height="215" xmlns="http://www.w3.org/2000/svg">
  <rect width="380" height="215" fill="#fdfdf8" stroke="#222" stroke-width="3"/>
  <text x="16" y="34" font-family="Arial" font-weight="bold" font-size="21">GIG LOGISTICS · WAYBILL</text>
  <text x="16" y="70" font-family="Arial" font-size="19">Tracking: ${escXml(tracking)}</text>
  <text x="16" y="102" font-family="Arial" font-size="16">To: ${escXml(name)}, ${escXml(country)}</text>
  <text x="16" y="128" font-family="Arial" font-size="16">From: ${escXml(from)}</text>
  ${bars}
</svg>`);
}

/**
 * Build a sample parcel photo for an order: the listed item ("genuine") or a different
 * product ("swap"), on a cardboard background with a waybill addressed to the buyer.
 */
export async function sampleParcel(orderId, kind = 'genuine') {
  const order = store.getOrder(orderId);
  if (!order) throw Object.assign(new Error('Order not found.'), { status: 404 });
  const product = store.getProduct(order.productId);
  let itemPath = product?.image;
  if (kind === 'swap') {
    const other = store.listProducts({ includeHidden: true }).find((p) => p.id !== product?.id && p.image && /\.(jpe?g|png|webp)$/i.test(p.image) && p.category === product?.category)
      || store.listProducts({ includeHidden: true }).find((p) => p.id !== product?.id && p.image && /\.(jpe?g|png|webp)$/i.test(p.image));
    itemPath = product?.swapImage || other?.image;
  }
  const item = await loadImageJpeg(itemPath);
  if (!item) throw Object.assign(new Error('No photo available for a sample parcel.'), { status: 400 });
  const rotated = await sharp(item).rotate(kind === 'swap' ? 6 : -8, { background: '#b98a55' }).resize(620, 620, { fit: 'inside' }).modulate({ brightness: 0.93 }).toBuffer();
  const tracking = `GIG-${String(parseInt(order.id.replace(/\W/g, '').slice(-6), 36) % 1e8).padStart(8, '4')}`;
  return sharp({ create: { width: 1000, height: 900, channels: 3, background: '#b98a55' } })
    .composite([
      { input: rotated, left: 40, top: 50 },
      { input: waybillSvg({ tracking, name: order.shipTo?.name || 'Buyer', country: order.shipTo?.countryCode || '', from: `${product?.sellerName || 'Seller'}, Lagos NG` }), left: 590, top: 640 },
    ])
    .jpeg({ quality: 85 })
    .withExif({ IFD0: { ImageDescription: kind === 'swap' ? 'SAMPLE:SWAP' : 'SAMPLE:GENUINE' } })
    .toBuffer();
}
