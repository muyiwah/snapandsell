// PayPal Orders v2 client (sandbox). Uses the REST API directly so every call is visible.
// Docs: https://developer.paypal.com/docs/api/orders/v2/
import crypto from 'node:crypto';
import { config, modes } from './config.js';

let cachedToken = null;

async function getAccessToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;
  const auth = Buffer.from(`${config.paypal.clientId}:${config.paypal.clientSecret}`).toString('base64');
  const res = await fetch(`${config.paypal.apiBase}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`PayPal auth failed (${res.status}): ${await res.text()}`);
  const json = await res.json();
  cachedToken = { value: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
  return cachedToken.value;
}

async function paypalFetch(pathname, { method = 'GET', body } = {}) {
  const token = await getAccessToken();
  const res = await fetch(`${config.paypal.apiBase}${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'PayPal-Request-Id': crypto.randomUUID(), // idempotency
      Prefer: 'return=representation',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const detail = json?.details?.[0]?.description || json?.message || text;
    const err = new Error(`PayPal ${method} ${pathname} failed (${res.status}): ${detail}`);
    err.status = res.status;
    err.paypal = json;
    throw err;
  }
  return json;
}

const money = (n) => (Math.round(Number(n) * 100) / 100).toFixed(2);

/**
 * Create a PayPal order for one product.
 * @param {{product: object, quantity?: number, returnUrl: string, cancelUrl: string, source: string}} args
 * @returns {Promise<{id: string, status: string, approveUrl: string|null}>}
 */
export async function createOrder({ product, quantity = 1, unitPriceUsd, returnUrl, cancelUrl, source }) {
  const unit = money(unitPriceUsd ?? product.priceUsd);
  const total = money(Number(unit) * quantity);

  if (modes.paypalMock) {
    const id = 'MOCK-' + crypto.randomBytes(6).toString('hex').toUpperCase();
    return { id, status: 'CREATED', approveUrl: `${config.baseUrl}/mock-paypal?token=${id}`, mock: true };
  }


  const order = await paypalFetch('/v2/checkout/orders', {
    method: 'POST',
    body: {
      // AUTHORIZE, not CAPTURE: the buyer approves and PayPal holds the money. We capture
      // only after the seller's parcel photo is verified (see captureAuthorization).
      intent: 'AUTHORIZE',
      purchase_units: [
        {
          reference_id: product.id,
          description: product.title.slice(0, 127),
          custom_id: `${product.id}|${source}`.slice(0, 127),
          amount: {
            currency_code: config.paypal.currency,
            value: total,
            breakdown: { item_total: { currency_code: config.paypal.currency, value: total } },
          },
          items: [
            {
              name: product.title.slice(0, 127),
              quantity: String(quantity),
              unit_amount: { currency_code: config.paypal.currency, value: unit },
              category: 'PHYSICAL_GOODS',
            },
          ],
        },
      ],
      // Redirect flow (AI agents, QR codes): PayPal sends the buyer back to our return URL.
      // Button flow (JS SDK on the product page): the SDK handles approval in a popup.
      ...(returnUrl
        ? {
            payment_source: {
              paypal: {
                experience_context: {
                  brand_name: config.store.name.slice(0, 127),
                  user_action: 'PAY_NOW',
                  shipping_preference: 'GET_FROM_FILE',
                  return_url: returnUrl,
                  cancel_url: cancelUrl,
                },
              },
            },
          }
        : {}),
    },
  });

  const approve = (order.links || []).find((l) => l.rel === 'payer-action' || l.rel === 'approve');
  return { id: order.id, status: order.status, approveUrl: approve?.href || null };
}

const shipToOf = (pu) => {
  const s = pu?.shipping;
  return s ? { name: s.name?.full_name || null, countryCode: s.address?.country_code || null, city: s.address?.admin_area_2 || null } : null;
};

/**
 * Authorize an approved order: PayPal places a hold on the buyer's funds.
 * Only ever called after the buyer approved on PayPal.
 */
export async function authorizeOrder(orderId) {
  if (modes.paypalMock) {
    return {
      id: orderId, status: 'COMPLETED', authorizationId: 'MOCKAUTH-' + orderId.slice(5),
      authorizationStatus: 'CREATED', payerEmail: 'sandbox-buyer@example.com',
      shipTo: { name: 'John Doe', countryCode: 'US', city: 'San Jose' },
      expiresAt: new Date(Date.now() + 29 * 864e5).toISOString(),
    };
  }
  const res = await paypalFetch(`/v2/checkout/orders/${encodeURIComponent(orderId)}/authorize`, { method: 'POST', body: {} });
  const pu = res.purchase_units?.[0];
  const auth = pu?.payments?.authorizations?.[0];
  return {
    id: res.id,
    status: res.status,
    authorizationId: auth?.id || null,
    authorizationStatus: auth?.status || null,
    payerEmail: res.payer?.email_address || null,
    shipTo: shipToOf(pu),
    expiresAt: auth?.expiration_time || null,
  };
}

/** Release held funds to the seller: capture the authorization in full. */
export async function captureAuthorization(authorizationId, { invoiceId, note } = {}) {
  if (modes.paypalMock) return { captureId: 'MOCKCAP-' + authorizationId.slice(9), status: 'COMPLETED' };
  const res = await paypalFetch(`/v2/payments/authorizations/${encodeURIComponent(authorizationId)}/capture`, {
    method: 'POST',
    body: { final_capture: true, ...(invoiceId ? { invoice_id: String(invoiceId).slice(0, 127) } : {}), ...(note ? { note_to_payer: String(note).slice(0, 255) } : {}) },
  });
  return { captureId: res.id, status: res.status };
}

/** Cancel the hold: the buyer is never charged. */
export async function voidAuthorization(authorizationId) {
  if (modes.paypalMock) return { status: 'VOIDED' };
  await paypalFetch(`/v2/payments/authorizations/${encodeURIComponent(authorizationId)}/void`, { method: 'POST' });
  return { status: 'VOIDED' };
}

/** Add shipment tracking to the PayPal order (shows for the buyer, supports Seller Protection). */
export async function addTracking(orderId, { captureId, trackingNumber, carrier }) {
  if (modes.paypalMock) return { ok: true, mock: true };
  const known = { ups: 'UPS', dhl: 'DHL', fedex: 'FEDEX', usps: 'USPS' };
  const code = known[String(carrier || '').toLowerCase().replace(/[^a-z]/g, '')];
  await paypalFetch(`/v2/checkout/orders/${encodeURIComponent(orderId)}/track`, {
    method: 'POST',
    body: {
      capture_id: captureId,
      tracking_number: String(trackingNumber).slice(0, 64),
      carrier: code || 'OTHER',
      ...(code ? {} : { carrier_name_other: String(carrier || 'Courier').slice(0, 64) }),
      notify_payer: true,
    },
  });
  return { ok: true };
}

export async function getOrderDetails(orderId) {
  if (modes.paypalMock) return { id: orderId, status: 'APPROVED' };
  return paypalFetch(`/v2/checkout/orders/${encodeURIComponent(orderId)}`);
}

/** Verify a webhook with PayPal's verify-webhook-signature API. */
export async function verifyWebhook(headers, event) {
  if (!config.paypal.webhookId || modes.paypalMock) return false;
  const res = await paypalFetch('/v1/notifications/verify-webhook-signature', {
    method: 'POST',
    body: {
      auth_algo: headers['paypal-auth-algo'],
      cert_url: headers['paypal-cert-url'],
      transmission_id: headers['paypal-transmission-id'],
      transmission_sig: headers['paypal-transmission-sig'],
      transmission_time: headers['paypal-transmission-time'],
      webhook_id: config.paypal.webhookId,
      webhook_event: event,
    },
  });
  return res.verification_status === 'SUCCESS';
}

export async function healthCheck() {
  if (modes.paypalMock) return { ok: true, mode: 'mock' };
  try {
    await getAccessToken();
    return { ok: true, mode: 'sandbox' };
  } catch (e) {
    return { ok: false, mode: 'sandbox', error: e.message };
  }
}
