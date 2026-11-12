// The AI shopping agent as a panel that lives inside the Shop page.
// Streams tool steps and the haggle live from POST /api/agent/chat (SSE).
import { api, usd, esc, myOrders } from '/common.js?v=4';

/**
 * Animated handshake shown when the two agents strike a deal: the buyer's arm (indigo) and the
 * seller's arm (green, gold cuff) slide in, clasp and shake; confetti bursts; "Deal!" pops in.
 */
const CONFETTI = ['#e8a317', '#16684f', '#6b70f0', '#d9583b', '#f5c451', '#4fd69c'];
function dealShake(price, list) {
  const el = document.createElement('div');
  el.className = 'dealshake';
  el.setAttribute('role', 'status');
  const bits = Array.from({ length: 18 }, (_, i) => {
    const a = (i / 18) * Math.PI * 2 + (i % 3) * 0.2;
    const d = 70 + (i % 4) * 22;
    return `<i style="--x:${Math.round(Math.cos(a) * d)}px;--y:${Math.round(Math.sin(a) * d * 0.7 - 10)}px;--r:${(i * 47) % 360}deg;--c:${CONFETTI[i % CONFETTI.length]};--d:${(i % 5) * 0.03}s"></i>`;
  }).join('');
  el.innerHTML = `
    <div class="ds-stage" aria-hidden="true">
      <span class="ds-ring"></span>
      <svg class="ds-svg" viewBox="40 22 140 66" width="140" height="66" preserveAspectRatio="xMidYMid meet">
        <g class="ds-clasp">
          <g class="ds-right">
            <rect x="140" y="44" width="84" height="30" rx="8" fill="#16684f"/>
            <rect x="134" y="41" width="12" height="36" rx="4" fill="#e8a317"/>
            <rect x="96" y="45" width="44" height="28" rx="14" fill="#8d5524"/>
            <ellipse cx="104" cy="74" rx="10" ry="6" fill="#7a4720"/>
          </g>
          <g class="ds-left">
            <rect x="-4" y="40" width="84" height="30" rx="8" fill="#3b3fb0"/>
            <rect x="74" y="37" width="12" height="36" rx="4" fill="#e5e7ff"/>
            <rect x="84" y="39" width="46" height="30" rx="15" fill="#c68642"/>
            <path d="M100 48 h22 M100 55 h24 M100 62 h21" stroke="rgba(80,40,10,.28)" stroke-width="2.4" stroke-linecap="round"/>
          </g>
          <!-- Thumbs cross on top: each rests on the other person's hand. -->
          <g class="ds-right"><path d="M118 44 q-10 -10 -24 -6 q-6 2 -2 6 q10 2 20 6 z" fill="#7a4720"/></g>
          <g class="ds-left"><path d="M98 40 q12 -11 26 -5 q5 3 0 6 q-12 1 -22 5 z" fill="#d9995e"/></g>
        </g>
      </svg>
      <div class="ds-confetti">${bits}</div>
    </div>
    <div class="ds-text">
      <div class="ds-title">Deal!</div>
      <div class="ds-price">${usd(price)}${list && list > price ? ` <s>${usd(list)}</s>` : ''}</div>
      <div class="ds-sub">Both agents shook on it${list && list > price ? `: you save ${usd(Math.round((list - price) * 100) / 100)}` : ''}</div>
    </div>`;
  return el;
}

/**
 * Escape a bot message, then turn http(s) URLs into links with readable labels.
 * Only http(s) is linked; everything else stays escaped text.
 */
const URL_RE = /https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/g;
function linkify(text) {
  const s = String(text ?? '');
  let out = '', last = 0;
  for (const m of s.matchAll(URL_RE)) {
    out += esc(s.slice(last, m.index)) + linkFor(m[0]);
    last = m.index + m[0].length;
  }
  return out + esc(s.slice(last));
}
function linkFor(raw) {
  {
    let u;
    try { u = new URL(raw); } catch { return esc(raw); }
    if (!/^https?:$/.test(u.protocol)) return esc(raw);
    const sameSite = u.origin === location.origin;
    const isPayPal = /(^|\.)paypal\.com$/.test(u.hostname);
    let label;
    if (isPayPal && /checkoutnow|webapps|checkout/.test(u.pathname)) label = 'Open PayPal checkout →';
    else if (sameSite && u.pathname.startsWith('/o/')) label = 'Track your order →';
    else if (sameSite && u.pathname.startsWith('/p/')) label = 'View the item →';
    else label = esc((u.hostname + u.pathname).replace(/\/$/, '').slice(0, 48) + ((u.hostname + u.pathname).length > 48 ? '…' : ''));
    // PayPal and our own pages open here (PayPal returns the buyer to their order); others in a new tab.
    const newTab = !(sameSite || isPayPal);
    return `<a class="msg-link${isPayPal ? ' pp' : ''}" href="${esc(u.href)}"${newTab ? ' target="_blank" rel="noopener noreferrer"' : ''}>${label}</a>`;
  }
}

export function mountAgent(root) {
  root.innerHTML = `
    <div class="agent-head">
      <div class="agent-title"><span class="agent-dot" aria-hidden="true">✦</span> AI shopping agent</div>
      <div class="hint">Tell it what you want. It searches the shop, haggles with the seller's agent, and prepares a PayPal checkout that <b>you</b> approve.</div>
    </div>
    <div class="msgs" data-msgs aria-live="polite">
      <div class="msg bot">Hi! What are you looking for, and what's your budget? I can also haggle for a better price.</div>
    </div>
    <div class="chips" data-chips>
      <button type="button" class="chip">A handmade bag for my sister, around $35</button>
      <button type="button" class="chip">Get me a deal on the Ankara buckle tote, my max is $34</button>
      <button type="button" class="chip">Buy it</button>
    </div>
    <form class="composer" data-form>
      <input data-input type="text" placeholder="e.g. a beaded necklace under $50" autocomplete="off" maxlength="500" aria-label="Message the AI shopping agent" />
      <button class="btn btn-primary" data-send>Send</button>
    </form>
    <details class="trailbox">
      <summary>What the agent is doing <span class="hint" data-count></span></summary>
      <div class="trail" data-trail><div class="hint">No actions yet.</div></div>
      <div class="hint" style="margin-top:8px">🔒 No tool can move money. The seller's lowest price stays private and is enforced by the shop. Agent orders are capped at <span data-cap>$250</span>.</div>
    </details>`;

  const $ = (s) => root.querySelector(s);
  const msgs = $('[data-msgs]');
  api('/.well-known/agent-store.json').then((m) => { $('[data-cap]').textContent = usd(m.payments.maxAgentOrderUsd); }).catch(() => {});

  const history = [];
  let firstTrail = true, haggleBox = null, steps = 0, busy = false;
  // Lets the page react (spotlight the item being haggled, disable buttons).
  const emit = (type, detail) => root.dispatchEvent(new CustomEvent(type, { detail }));
  const running = new Map();
  // Follow the newest message after layout (rAF), smoothly unless the user prefers less motion.
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const scroll = () => requestAnimationFrame(() => msgs.scrollTo({ top: msgs.scrollHeight, behavior: reduce ? 'auto' : 'smooth' }));

  function addMsg(role, text) {
    const div = document.createElement('div');
    div.className = `msg ${role === 'user' ? 'user' : 'bot'}`;
    if (role === 'user') div.textContent = text;
    else div.innerHTML = linkify(text);
    msgs.appendChild(div);
    scroll();
    return div;
  }

  function summary(step) {
    const r = step.result || {};
    if (r.error) return `<span class="pill warn">${esc(r.error)}</span>`;
    if (step.tool === 'search_products') return `${(r.products || []).length} result(s): ${(r.products || []).map((p) => esc(p.title) + ' ' + usd(p.priceUsd)).join(', ') || 'none'}`;
    if (step.tool === 'get_product') return esc(r.product?.title || '');
    if (step.tool === 'negotiate_price') return r.agreed ? `Deal at <b>${usd(r.priceUsd)}</b> (list ${usd(r.listPriceUsd)})` : 'No deal within budget';
    if (step.tool === 'start_checkout') return `PayPal order <b>${esc(r.orderId)}</b> for ${usd(r.total)}. Nothing charged yet.`;
    if (step.tool === 'get_order_status') return esc(r.statusText || '');
    return '';
  }

  // ---------- context-aware suggestion chips ----------
  // What happened in the current turn, so the next suggestions fit the conversation.
  let turn = {};
  let lastProducts = [];
  const short = (t) => { const w = String(t || 'it').split(/\s+/); return w.length > 3 ? w.slice(0, 3).join(' ') + '…' : w.join(' '); };
  const money = (n) => Math.round(Number(n) * 100) / 100;
  const titleOf = (id) => lastProducts.find((p) => p.id === id)?.title;

  function track(step) {
    const r = step.result || {};
    if (r.error) { turn.error = r.error; return; }
    if (step.tool === 'search_products' && r.products) { lastProducts = r.products; turn.search = r.products; }
    if (step.tool === 'negotiate_price') {
      const sellerOffers = (r.transcript || []).filter((m) => m.side === 'seller').map((m) => m.offerUsd);
      turn.neg = {
        id: step.args?.product_id, title: titleOf(step.args?.product_id) || haggleTitle, budget: Number(step.args?.max_price_usd),
        agreed: r.agreed, price: r.priceUsd, list: r.listPriceUsd, sellerLast: sellerOffers.length ? sellerOffers[sellerOffers.length - 1] : null,
      };
    }
    if (step.tool === 'start_checkout' && r.orderId) turn.checkout = r;
  }

  function suggestions() {
    const { neg, search, checkout, error } = turn;
    if (checkout) {
      return [
        { label: 'Is my order paid yet?', msg: `What's the status of order ${checkout.orderId}?` },
        { label: 'Find something else', msg: 'Find me something else I might like' },
        { label: 'Go to My orders →', href: '/orders' },
      ];
    }
    if (neg && neg.agreed) {
      return [
        { label: `Buy it at ${usd(neg.price)}`, msg: `Buy the ${neg.title || 'item'} using the deal` },
        { label: 'Show me similar items', msg: `Show me items similar to the ${neg.title || 'last one'}` },
        { label: 'Haggle something else', msg: 'What else could you get me a deal on?' },
      ];
    }
    if (neg && neg.agreed === false && neg.title) {
      const list = Number(neg.list) || null;
      const plusOne = money(Math.min(neg.budget + 1, list || Infinity));
      const out = [];
      if (list && plusOne < list) out.push({ label: `Put a dollar on top (${usd(plusOne)})`, msg: `Put a dollar on top: try again for the ${neg.title}, my max is $${plusOne}` });
      if (neg.sellerLast && neg.sellerLast > neg.budget && (!list || neg.sellerLast < list)) out.push({ label: `Meet the seller at ${usd(neg.sellerLast)}`, msg: `OK, meet the seller: try again for the ${neg.title}, my max is $${money(neg.sellerLast)}` });
      if (list) out.push({ label: `Pay the full ${usd(list)}`, msg: `Buy the ${neg.title} at the full price` });
      out.push({ label: `Find something under ${usd(neg.budget)}`, msg: `Find me something else under $${neg.budget}` });
      return out;
    }
    if (search && search.length) {
      const p = search[0];
      return [
        { label: `Haggle for the ${short(p.title)}`, msg: `Get me a deal on the ${p.title}, my max is $${Math.floor(p.priceUsd * 0.9)}` },
        { label: `Buy the ${short(p.title)}`, msg: `Buy the ${p.title}` },
        { label: 'Show me something cheaper', msg: `Show me something cheaper than $${p.priceUsd}` },
      ];
    }
    if (error) return [{ label: 'Try again', msg: lastUserText }, { label: "Show me what's in the shop", msg: "Show me what's in the shop" }];
    return null; // nothing notable: keep the current chips
  }

  function renderChips(list) {
    if (!list) return;
    const box = $('[data-chips]');
    box.innerHTML = list.map((c) => (c.href
      ? `<a class="chip chip-link" href="${esc(c.href)}">${esc(c.label)}</a>`
      : `<button type="button" class="chip" data-msg="${esc(c.msg)}">${esc(c.label)}</button>`)).join('');
    box.classList.remove('chips-new'); void box.offsetWidth; box.classList.add('chips-new');
    box.scrollLeft = 0;
  }

  function onStep(step) {
    emit('agent:step', step);
    if ('result' in step) track(step);
    const trail = $('[data-trail]');
    if (firstTrail) { trail.innerHTML = ''; firstTrail = false; }
    const key = step.tool + JSON.stringify(step.args);
    let el = running.get(key);
    if (!el) { el = document.createElement('div'); el.className = 'tstep'; trail.appendChild(el); }
    const done = 'result' in step;
    el.innerHTML = `<div><code>${esc(step.tool)}</code> <span class="hint">${esc(JSON.stringify(step.args))}</span></div><div>${done ? summary(step) : 'running…'}</div>`;
    if (done) { running.delete(key); steps++; $('[data-count]').textContent = `(${steps} step${steps > 1 ? 's' : ''})`; } else running.set(key, el);

    if (done && step.tool === 'start_checkout' && step.result.approveUrl) {
      const r = step.result;
      myOrders.add({ id: r.orderId, title: r.title, amount: r.total, approveUrl: r.approveUrl, viaAgent: true });
      const card = document.createElement('div');
      card.className = 'checkout-card msg bot';
      card.style.maxWidth = '100%';
      card.innerHTML = `<b>${esc(r.title)}</b> × ${r.quantity} · <b>${usd(r.total)}</b> ${r.negotiated ? '<span class="pill ok">negotiated</span>' : ''}<br>
        <span class="hint">Nothing has been charged. Approve on PayPal; PayPal then holds the money until the seller's parcel is verified. This order is saved under <a href="/orders">My orders</a>.</span>
        <div class="btns"><a class="btn btn-pp" href="${esc(r.approveUrl)}">Review &amp; approve on PayPal</a></div>`;
      msgs.appendChild(card);
      scroll();
    }
  }

  let haggleList = null, haggleTitle = null, lastUserText = '';
  function onHaggle(e) {
    if (e.type === 'haggle_start') {
      haggleList = e.listPriceUsd;
      haggleTitle = e.productTitle;
      haggleBox = document.createElement('div');
      haggleBox.className = 'haggle';
      haggleBox.innerHTML = `<div class="hhead"><b>🤝 Haggling: ${esc(e.productTitle)}</b><span>list ${usd(e.listPriceUsd)}</span></div>`;
      msgs.appendChild(haggleBox);
    } else if (e.type === 'haggle' && haggleBox) {
      const b = document.createElement('div');
      b.className = `hb ${e.side}${e.accept ? ' accept' : ''}`;
      b.innerHTML = `<div class="who">${e.side === 'buyer' ? 'Your agent' : "Seller's agent"}</div><div>${esc(e.message)}</div><div class="amt">${e.accept ? `✓ ${usd(e.offerUsd)}` : usd(e.offerUsd)}</div>`;
      haggleBox.appendChild(b);
    } else if (e.type === 'haggle_end' && haggleBox) {
      haggleBox.appendChild(e.agreed ? dealShake(e.priceUsd, haggleList) : Object.assign(document.createElement('div'), { className: 'deal', textContent: 'No deal within your budget' }));
      haggleBox = null;
    }
    emit('agent:haggle', e);
    scroll();
  }

  async function stream(messages, handlers) {
    const res = await fetch('/api/agent/chat', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' }, body: JSON.stringify({ messages }) });
    if (!res.ok || !res.body) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error || `Request failed (${res.status})`);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = /^event: (.*)$/m.exec(block)?.[1];
        const data = /^data: (.*)$/m.exec(block)?.[1];
        if (ev && data) handlers[ev]?.(JSON.parse(data));
      }
    }
  }

  async function send(text) {
    if (!text.trim()) return;
    turn = {};
    lastUserText = text;
    addMsg('user', text);
    history.push({ role: 'user', content: text });
    $('[data-input]').value = '';
    $('[data-send]').disabled = true;
    const thinking = addMsg('bot', 'Thinking…');
    let finished = false;
    try {
      await stream(history.slice(-12), {
        step: (s) => { thinking.textContent = s.tool === 'negotiate_price' && !('result' in s) ? 'Haggling with the seller’s agent…' : 'Working…'; onStep(s); },
        haggle: onHaggle,
        done: (res) => {
          finished = true;
          thinking.remove();
          const ids = (res.steps || []).map((s) => s.result?.dealId || s.result?.orderId).filter(Boolean);
          const reply = res.reply || '(no reply)';
          addMsg('bot', reply);
          history.push({ role: 'assistant', content: ids.length && !ids.every((x) => reply.includes(x)) ? `${reply}\n[ref: ${ids.join(', ')}]` : reply });
        },
        error: (e) => { finished = true; turn.error = e.error; thinking.textContent = `Sorry, something went wrong: ${e.error}`; },
      });
      if (!finished) { turn.error = 'dropped'; thinking.textContent = 'The connection dropped. Please try again.'; }
    } catch (e) {
      turn.error = e.message;
      thinking.textContent = `Sorry, something went wrong: ${e.message}`;
    } finally {
      busy = false;
      $('[data-send]').disabled = false;
      renderChips(suggestions());
      root.querySelectorAll('[data-chips] .chip').forEach((c) => (c.disabled = false));
      emit('agent:busy', false);
    }
  }

  // One request at a time: a second one would talk over the first.
  function guardedSend(text) {
    if (busy || !text.trim()) return false;
    busy = true;
    root.querySelectorAll('[data-chips] .chip').forEach((c) => (c.disabled = true));
    emit('agent:busy', true);
    send(text);
    return true;
  }

  $('[data-form]').addEventListener('submit', (e) => { e.preventDefault(); guardedSend($('[data-input]').value); });
  $('[data-chips]').addEventListener('click', (e) => {
    const chip = e.target.closest('button.chip');
    if (chip) guardedSend(chip.dataset.msg || chip.textContent);
  });
  return { send: guardedSend, focus: () => $('[data-input]').focus(), get busy() { return busy; } };
}
