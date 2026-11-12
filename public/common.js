// Shared helpers for every page: header, mock banner, API calls.
export const $ = (s, el = document) => el.querySelector(s);
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const usd = (n) => `$${Number(n).toFixed(Number(n) % 1 ? 2 : 0)}`;

export async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: opts.body instanceof FormData ? opts.headers : { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
  return json;
}

let cfgPromise;
export const getConfig = () => (cfgPromise ??= api('/api/config'));

export async function header(active) {
  const links = [
    ['/', 'Sell', 'sell'],
    ['/store', 'Shop', 'store'],
    ['/orders', 'My orders', 'orders'],
    ['/dashboard', 'Seller dashboard', 'dashboard'],
  ];
  const top = document.createElement('header');
  top.className = 'top';
  top.innerHTML = `<div class="top-inner">
    <a class="brand" href="/"><span class="dot"></span>Snap &amp; Sell</a>
    <nav class="nav">${links.map(([h, t, k]) => `<a href="${h}" class="${k === active ? 'on' : ''}">${t}</a>`).join('')}</nav>
  </div>`;
  document.body.prepend(top);

  try {
    const cfg = await getConfig();
    const notes = [];
    if (cfg.modes.paypalMock) notes.push('PayPal is in MOCK mode (no sandbox keys set)');
    if (cfg.modes.aiMock) notes.push('AI is in DEMO mode (no Meta API key set)');
    if (notes.length) {
      const bar = document.createElement('div');
      bar.className = 'mockbar';
      bar.textContent = notes.join(' · ');
      top.after(bar);
    }
  } catch { /* ignore */ }
}

export const STATUS = {
  CREATED: { label: 'Awaiting approval', cls: '' },
  HELD: { label: 'Held by PayPal', cls: 'held' },
  FLAGGED: { label: 'Flagged · held', cls: 'bad' },
  PAID: { label: 'Paid to seller', cls: 'ok' },
  VOIDED: { label: 'Cancelled', cls: '' },
};

const VERDICT_TEXT = {
  release: ['✅ Parcel verified, money released', 'The parcel matches the listing and has a readable waybill. PayPal captured the payment.'],
  hold: ['⏸️ Money still held', 'The check was not conclusive. The seller can send a clearer photo.'],
  reject: ['🛑 Different item: money still held', 'The parcel does not match what the buyer paid for. The buyer is protected and can cancel for free.'],
};

/** Render one proof-of-shipment check (listing vs parcel photo + AI findings). */
export function verdictHtml(v) {
  const c = v.check || {};
  const [title, sub] = VERDICT_TEXT[v.decision] || VERDICT_TEXT.hold;
  const list = (arr) => (arr || []).map((x) => `<li>${esc(x)}</li>`).join('');
  const fact = (k, val) => `<div class="fact"><div class="k">${k}</div><div class="v">${val == null || val === '' ? '<span class="hint">not readable</span>' : esc(val)}</div></div>`;
  return `
    <div class="compare">
      <figure><img src="${esc(v.listingImage || '')}" alt="Listing photo" /><figcaption>What the buyer paid for</figcaption></figure>
      <figure><img src="${esc(v.image || '')}" alt="Parcel photo from the seller" /><figcaption>Seller's parcel photo</figcaption></figure>
    </div>
    <div class="verdict ${esc(v.decision)}">
      <h3>${title}</h3>
      <div class="hint">${sub}</div>
      ${c.summary ? `<p style="margin:8px 0 0">${esc(c.summary)}</p>` : ''}
      ${c.matchingDetails?.length ? `<div style="margin-top:8px;font-weight:600;font-size:13px">Matches</div><ul>${list(c.matchingDetails)}</ul>` : ''}
      ${c.differences?.length ? `<div style="margin-top:8px;font-weight:600;font-size:13px">Differences</div><ul>${list(c.differences)}</ul>` : ''}
      ${v.decision !== 'release' && v.reasons?.length ? `<div style="margin-top:8px;font-weight:600;font-size:13px">Why the money is held</div><ul>${list(v.reasons)}</ul>` : ''}
      <div class="facts">
        ${fact('Same item', c.sameItem ? `Yes · ${Math.round((c.confidence || 0) * 100)}%` : `No · ${Math.round((c.confidence || 0) * 100)}%`)}
        ${fact('Tracking', c.trackingNumber)}
        ${fact('Carrier', c.carrier)}
        ${fact('Recipient', c.recipientName ? `${c.recipientName}${c.recipientCountry ? ', ' + c.recipientCountry : ''}${c.recipientMatches === true ? ' ✓' : c.recipientMatches === false ? ' ✗' : ''}` : null)}
      </div>
      <div class="hint" style="margin-top:8px">Checked by ${esc(c.model || 'Muse Spark')}${v.ms ? ` in ${(v.ms / 1000).toFixed(1)}s` : ''}. The AI reports what it sees; fixed rules decide whether money moves.</div>
    </div>`;
}

/**
 * Orders placed in this browser (no buyer accounts: PayPal is the login).
 * Per-device convenience only; storage can be unavailable, so every access is guarded.
 */
const MY_KEY = 'snapsell.myOrders';
export const myOrders = {
  list() {
    try { return JSON.parse(localStorage.getItem(MY_KEY) || '[]'); } catch { return []; }
  },
  add(o) {
    try {
      const all = myOrders.list().filter((x) => x.id !== o.id);
      const prev = myOrders.list().find((x) => x.id === o.id) || {};
      all.unshift({ ...prev, ...o, at: prev.at || new Date().toISOString() });
      localStorage.setItem(MY_KEY, JSON.stringify(all.slice(0, 50)));
    } catch { /* storage unavailable: the order page link still works */ }
  },
};
