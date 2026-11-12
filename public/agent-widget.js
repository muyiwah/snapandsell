// The AI shopping agent as a panel that lives inside the Shop page.
// Streams tool steps and the haggle live from POST /api/agent/chat (SSE).
import { api, usd, esc, myOrders } from '/common.js';

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
  let firstTrail = true, haggleBox = null, steps = 0;
  const running = new Map();
  const scroll = () => { msgs.scrollTop = msgs.scrollHeight; };

  function addMsg(role, text) {
    const div = document.createElement('div');
    div.className = `msg ${role === 'user' ? 'user' : 'bot'}`;
    div.textContent = text;
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

  function onStep(step) {
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

  function onHaggle(e) {
    if (e.type === 'haggle_start') {
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
      const d = document.createElement('div');
      d.className = 'deal';
      d.textContent = e.agreed ? `Deal agreed at ${usd(e.priceUsd)}` : 'No deal within your budget';
      haggleBox.appendChild(d);
      haggleBox = null;
    }
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
        error: (e) => { finished = true; thinking.textContent = `Sorry, something went wrong: ${e.error}`; },
      });
      if (!finished) thinking.textContent = 'The connection dropped. Please try again.';
    } catch (e) {
      thinking.textContent = `Sorry, something went wrong: ${e.message}`;
    } finally {
      $('[data-send]').disabled = false;
    }
  }

  $('[data-form]').addEventListener('submit', (e) => { e.preventDefault(); send($('[data-input]').value); });
  $('[data-chips]').addEventListener('click', (e) => { if (e.target.classList.contains('chip')) send(e.target.textContent); });
  return { send, focus: () => $('[data-input]').focus() };
}
