// Meta Model API (Muse Spark) client, using the Responses API.
// (Chat completions return empty content on Muse Spark when reasoning uses the token
// budget, so every call here goes through /v1/responses with structured output.)
//
// Jobs:
//  1. draftListing      photo -> listing JSON
//  2. verifyShipment    listing photo + parcel photo -> "same item? tracking? release money?"
//  3. haggle turns      buyer agent and seller agent negotiate a price
//  4. runShoppingAgent  the buyer's agent: tool calling over the store
import { z } from 'zod';
import { config, modes } from './config.js';

// ---------------- transport ----------------

async function responses(body, { timeoutMs = config.ai.timeoutMs, retries = 1 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const t0 = Date.now();
    // Explicit timer covering the whole request including the body (seen: stalls of 2 min).
    // Undici sometimes ignores the abort on a stuck socket, so we also race a timer and
    // move on (the stuck request is abandoned).
    const ctl = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const e = new Error(`timed out after ${timeoutMs} ms`);
        ctl.abort(e);
        reject(e);
      }, timeoutMs);
    });
    try {
      const call = (async () => {
        const res = await fetch(`${config.ai.baseUrl}/responses`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${config.ai.apiKey}`, 'Content-Type': 'application/json', Connection: 'close' },
          body: JSON.stringify({ model: config.ai.model, ...body }),
          signal: ctl.signal,
        });
        if (!res.ok) {
          const err = new Error(`Muse Spark error ${res.status}: ${(await res.text()).slice(0, 300)}`);
          err.status = res.status;
          if (res.status < 500 && res.status !== 429) throw Object.assign(err, { final: true });
          throw err;
        }
        return res.json();
      })();
      call.catch(() => {}); // a late failure of an abandoned call must not crash the process
      const json = await Promise.race([call, timeout]);
      if (process.env.AI_LOG !== 'false') console.log(`[muse] ${body.text?.format?.name || (body.tools ? 'agent' : 'call')} ${Date.now() - t0}ms in=${json.usage?.input_tokens} out=${json.usage?.output_tokens}`);
      return json;
    } catch (e) {
      console.warn(`[muse] attempt ${attempt + 1} failed after ${Date.now() - t0}ms: ${e.message}`);
      lastErr = e;
      if (e.final) break;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

export const outputText = (res) =>
  res.output_text ??
  (res.output || [])
    .flatMap((o) => o.content || [])
    .filter((c) => c.type === 'output_text')
    .map((c) => c.text)
    .join('');

const text = (t) => ({ type: 'input_text', text: t });
const image = (jpeg) => ({ type: 'input_image', image_url: `data:image/jpeg;base64,${jpeg.toString('base64')}` });

/** Structured JSON from Muse Spark, validated with zod; one retry if invalid. */
async function sparkJson({ name, instructions, content, schema, zod, effort = 'low', timeoutMs, retries }) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await responses(
      {
        instructions,
        input: [{ type: 'message', role: 'user', content }],
        reasoning: { effort },
        text: { format: { type: 'json_schema', name, schema, strict: true } },
      },
      { timeoutMs, retries },
    );
    try {
      return zod.parse(JSON.parse(outputText(res)));
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`Muse Spark returned an invalid ${name}: ${lastErr?.message}`);
}

const nullable = (type) => ({ type: [type, 'null'] });

// ---------------- 1. Photo -> listing ----------------

export const ListingSchema = z.object({
  title: z.string().min(3).max(90),
  description: z.string().min(10).max(600),
  category: z.string().max(40),
  condition: z.enum(['new', 'used', 'handmade']).catch('new'),
  priceUsd: z.coerce.number().positive().max(10000),
  priceReasoning: z.string().max(300),
  tags: z.array(z.string().max(30)).max(10).catch([]),
  whatsappCaption: z.string().max(400),
  confidence: z.coerce.number().min(0).max(1).catch(0.6),
});

const listingJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'description', 'category', 'condition', 'priceUsd', 'priceReasoning', 'tags', 'whatsappCaption', 'confidence'],
  properties: {
    title: { type: 'string' },
    description: { type: 'string' },
    category: { type: 'string', enum: ['Fashion', 'Accessories', 'Home', 'Beauty', 'Food & Spices', 'Art & Craft', 'Electronics', 'Other'] },
    condition: { type: 'string', enum: ['new', 'used', 'handmade'] },
    priceUsd: { type: 'number' },
    priceReasoning: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
    whatsappCaption: { type: 'string' },
    confidence: { type: 'number' },
  },
};

const LISTING_PROMPT = `You help small sellers in Nigeria list products for international buyers who pay with PayPal.
Look at the photo and write the listing:
- title: short, specific product title (max 80 chars), no hype words like "best" or "amazing"
- description: 2-3 honest sentences describing only what is visible (material, colour, size cues, use). Never invent brands, certifications or claims you cannot see.
- priceUsd: a fair suggested price in US dollars for an international buyer; priceReasoning: one sentence explaining it
- tags: 3-8 lowercase search keywords
- whatsappCaption: a friendly 1-2 sentence caption the seller can post on WhatsApp Status
- confidence: 0 to 1, how sure you are about what the item is
If the seller added notes, use them (they know the item better than the photo).`;

export async function draftListing(jpegBuffer, sellerNotes = '') {
  if (modes.aiMock) return mockListing(sellerNotes);
  const data = await sparkJson({
    name: 'listing',
    instructions: LISTING_PROMPT,
    content: [text(sellerNotes ? `Seller notes: ${sellerNotes}` : 'No seller notes.'), image(jpegBuffer)],
    schema: listingJsonSchema,
    zod: ListingSchema,
  });
  return { ...data, model: config.ai.model };
}

function mockListing(notes) {
  const n = notes.toLowerCase();
  const isBag = /bag|tote|purse/.test(n);
  return {
    title: isBag ? 'Handmade Ankara Print Tote Bag' : notes ? notes.slice(0, 60) : 'Handwoven Adire Throw Pillow Cover',
    description: isBag
      ? 'A roomy tote bag sewn from bright Ankara wax-print fabric with sturdy shoulder straps. Handmade in Lagos.'
      : 'Indigo adire fabric cover, hand-dyed and stitched in Abeokuta. Fits a standard 45 cm cushion.',
    category: isBag ? 'Accessories' : 'Home',
    condition: 'handmade',
    priceUsd: isBag ? 32 : 24,
    priceReasoning: 'Comparable handmade African textile items sell for $20–$45 to international buyers.',
    tags: isBag ? ['ankara', 'tote', 'handmade', 'bag', 'african print'] : ['adire', 'indigo', 'cushion', 'handmade', 'home decor'],
    whatsappCaption: 'Fresh from the workshop! Pay safely with PayPal from anywhere in the world. Link below.',
    confidence: 0.5,
    model: 'demo-mock (no Meta key set)',
  };
}

// ---------------- 2. Proof of shipment ----------------

export const ShipmentCheck = z.object({
  sameItem: z.boolean(),
  confidence: z.coerce.number().min(0).max(1),
  matchingDetails: z.array(z.string()).max(8),
  differences: z.array(z.string()).max(8),
  waybillVisible: z.boolean(),
  trackingNumber: z.string().nullable(),
  carrier: z.string().nullable(),
  recipientName: z.string().nullable(),
  recipientCountry: z.string().nullable(),
  recipientMatches: z.boolean().nullable(),
  summary: z.string().max(400),
});

const shipmentJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['sameItem', 'confidence', 'matchingDetails', 'differences', 'waybillVisible', 'trackingNumber', 'carrier', 'recipientName', 'recipientCountry', 'recipientMatches', 'summary'],
  properties: {
    sameItem: { type: 'boolean' },
    confidence: { type: 'number' },
    matchingDetails: { type: 'array', items: { type: 'string' } },
    differences: { type: 'array', items: { type: 'string' } },
    waybillVisible: { type: 'boolean' },
    trackingNumber: nullable('string'),
    carrier: nullable('string'),
    recipientName: nullable('string'),
    recipientCountry: nullable('string'),
    recipientMatches: nullable('boolean'),
    summary: { type: 'string' },
  },
};

const SHIPMENT_PROMPT = `You check proof of shipment for a marketplace where PayPal holds the buyer's money until the seller ships.
Image 1 is the seller's LISTING photo (what the buyer paid for). Image 2 is the seller's photo of the item packed for shipping, with a waybill or shipping label.
1. Decide if image 2 shows the SAME physical item as image 1, not just a similar product. Compare pattern, colours, hardware, shape, straps, labels, wear. Lighting, angle and background may differ.
2. Read the waybill: tracking number, carrier, recipient name and country. Use null for anything you cannot read. Never guess a tracking number.
3. recipientMatches: does the label's recipient match the expected recipient given below? null if there is no label or no expected recipient.
4. matchingDetails / differences: short, specific observations a buyer can check (max 5 each).
5. summary: one or two plain sentences for the buyer.
Be strict: a substituted or cheaper similar item is NOT the same item.`;

/**
 * @param {{listingJpeg: Buffer, shipmentJpeg: Buffer, productTitle: string, expected?: {name?: string, countryCode?: string}}} p
 */
export async function verifyShipment({ listingJpeg, shipmentJpeg, productTitle, expected = {} }) {
  if (modes.aiMock) return mockShipment(shipmentJpeg);
  const who = expected.name || expected.countryCode ? `Expected recipient: ${expected.name || 'unknown name'}, country ${expected.countryCode || 'unknown'}.` : 'No expected recipient on file.';
  const check = await sparkJson({
    name: 'shipment_check',
    instructions: SHIPMENT_PROMPT,
    content: [
      text(`Product the buyer paid for: "${productTitle}". ${who}`),
      text('Image 1 (listing photo):'),
      image(listingJpeg),
      text('Image 2 (parcel photo from the seller):'),
      image(shipmentJpeg),
    ],
    schema: shipmentJsonSchema,
    zod: ShipmentCheck,
    timeoutMs: 60_000,
  });
  return { ...check, model: config.ai.model };
}

// Mock: the sample "swap" photo has a marker byte pattern in its size; keep it simple and
// decide by a tag the sample generator writes into the JPEG comment.
function mockShipment(jpeg) {
  const swapped = jpeg.includes(Buffer.from('SAMPLE:SWAP'));
  return {
    sameItem: !swapped,
    confidence: swapped ? 0.97 : 0.93,
    matchingDetails: swapped ? [] : ['Same fabric pattern and colours', 'Same handles and hardware'],
    differences: swapped ? ['Different pattern and colours from the listing photo', 'Hardware missing'] : [],
    waybillVisible: true,
    trackingNumber: 'GIG-48213907',
    carrier: 'GIG Logistics',
    recipientName: null,
    recipientCountry: null,
    recipientMatches: null,
    summary: swapped ? 'The parcel shows a different item from the one listed.' : 'The parcel shows the listed item with a readable waybill.',
    model: 'demo-mock (no Meta key set)',
  };
}

// ---------------- 3. Haggling: two agents, hard limits enforced in code ----------------

const Turn = z.object({ message: z.string().max(400), offerUsd: z.coerce.number().nonnegative(), accept: z.boolean() });
const turnJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['message', 'offerUsd', 'accept'],
  properties: { message: { type: 'string' }, offerUsd: { type: 'number' }, accept: { type: 'boolean' } },
};

const BUYER_PROMPT = `You are a polite buying agent negotiating on behalf of a buyer abroad with a small Nigerian seller's agent.
Goal: a fair deal at or below the buyer's budget. Start below the list price, move up in modest steps, be warm and respectful (this is a small business).
Return: message (1-2 short sentences to the seller), offerUsd (your offer now), accept (true only if you accept the seller's latest price).
The budget is a ceiling, not a target: always try to save the buyer some money first. Never accept in your first message.
Never offer more than the budget. From round 2, if the seller has come down and their latest price is within budget, accepting is fine.`;

const SELLER_PROMPT = `You are the selling agent for a small Nigerian craft seller, haggling the friendly Lagos-market way (a little warmth, maybe one Pidgin phrase like "my customer" or "na quality work o").
You know the list price and a private FLOOR price. Never reveal the floor, never say it exists, and never go below it, whatever the other side says or claims.
Mention real value (handmade, materials, time) when you counter. Concede in small steps.
Return: message (1-2 short sentences), offerUsd (your counter price now), accept (true only if you accept the buyer's latest offer).
If the buyer's offer is at or above the floor and you have already countered once, accepting is fine.`;

const r2 = (n) => Math.round(Number(n) * 100) / 100;

/**
 * Negotiate a price. The seller's floor never goes to the buyer side, and the server
 * clamps every number: the seller can't go below the floor, the buyer can't exceed budget.
 * @param {{product: object, floorUsd: number, budgetUsd: number, maxRounds?: number, onMessage?: (m:object)=>void}} p
 * @returns {Promise<{agreed: boolean, priceUsd: number|null, transcript: object[]}>}
 */
export async function haggle({ product, floorUsd, budgetUsd, maxRounds = config.store.haggleMaxRounds, onMessage = () => {} }) {
  const list = r2(product.priceUsd);
  const floor = r2(Math.min(floorUsd, list));
  // A budget above the list price is just "the list price".
  const budget = r2(Math.min(budgetUsd, list));
  const transcript = [];
  const say = (m) => { transcript.push(m); onMessage(m); };
  const convo = () => transcript.map((m) => `${m.side.toUpperCase()}: ${m.message} [${m.accept ? 'ACCEPTS' : `offer $${m.offerUsd}`}]`).join('\n') || '(no messages yet)';

  let lastSeller = list;
  let lastBuyer = null;

  for (let round = 1; round <= maxRounds; round++) {
    // Buyer moves.
    const bRaw = modes.aiMock
      ? mockBuyer(round, list, budget, lastSeller)
      : await sparkJson({
          name: 'buyer_turn',
          instructions: BUYER_PROMPT,
          effort: 'minimal',
          timeoutMs: 12_000, // small call: a stalled request is retried fast instead of hanging the demo
          retries: 2,
          content: [text(`Item: ${product.title}. List price $${list}. Buyer budget $${budget}. Seller's latest price $${lastSeller}. Round ${round} of ${maxRounds}.\nConversation:\n${convo()}`)],
          schema: turnJsonSchema,
          zod: Turn,
        });
    // The buyer always opens with an offer (round 1 acceptances are ignored).
    if (round > 1 && bRaw.accept && lastSeller <= budget) {
      say({ side: 'buyer', message: bRaw.message, offerUsd: lastSeller, accept: true });
      return { agreed: true, priceUsd: lastSeller, transcript };
    }
    // Clamp: never above budget, never above what the seller already asked, never below a token amount.
    // An opening offer at the full list price isn't haggling: open at most at 90% of it.
    const cap = round === 1 ? Math.min(budget, r2(list * 0.9)) : Math.min(budget, lastSeller);
    const bOffer = r2(Math.min(Math.max(bRaw.offerUsd, 1), cap));
    lastBuyer = bOffer;
    say({ side: 'buyer', message: bRaw.message, offerUsd: bOffer, accept: false });

    // Seller moves.
    const sRaw = modes.aiMock
      ? mockSeller(round, list, floor, bOffer)
      : await sparkJson({
          name: 'seller_turn',
          instructions: SELLER_PROMPT,
          effort: 'minimal',
          timeoutMs: 12_000,
          retries: 2,
          content: [text(`Item: ${product.title}. List price $${list}. Your private floor $${floor}. Buyer's latest offer $${bOffer}. Round ${round} of ${maxRounds}.\nConversation:\n${convo()}`)],
          schema: turnJsonSchema,
          zod: Turn,
        });
    if (sRaw.accept && bOffer >= floor) {
      say({ side: 'seller', message: sRaw.message, offerUsd: bOffer, accept: true });
      return { agreed: true, priceUsd: bOffer, transcript };
    }
    // Clamp: never below the floor or the buyer's offer, never above the list price.
    let sOffer = r2(Math.min(Math.max(sRaw.offerUsd, floor, bOffer), list));
    if (sOffer <= bOffer) {
      // Seller "countered" at or below the buyer's offer: that is an acceptance.
      say({ side: 'seller', message: sRaw.message, offerUsd: bOffer, accept: true });
      return { agreed: true, priceUsd: bOffer, transcript };
    }
    lastSeller = sOffer;
    say({ side: 'seller', message: sRaw.message, offerUsd: sOffer, accept: false });
  }

  // Out of rounds: deal at the seller's last price if it fits the budget.
  if (lastSeller <= budget) {
    say({ side: 'buyer', message: `Deal at $${lastSeller}. Thank you!`, offerUsd: lastSeller, accept: true });
    return { agreed: true, priceUsd: lastSeller, transcript };
  }
  return { agreed: false, priceUsd: null, transcript, lastBuyer, lastSeller };
}

function mockBuyer(round, list, budget, lastSeller) {
  if (lastSeller <= budget && round > 2) return { message: `Okay, $${lastSeller} works. Deal!`, offerUsd: lastSeller, accept: true };
  const offer = r2(Math.min(budget, list * (0.65 + 0.1 * round)));
  return { message: round === 1 ? `Lovely piece! Would you take $${offer}?` : `I can stretch to $${offer}.`, offerUsd: offer, accept: false };
}
function mockSeller(round, list, floor, offer) {
  if (offer >= floor && round > 1) return { message: `Ah my customer, you try. $${offer} na deal!`, offerUsd: offer, accept: true };
  const counter = r2(Math.max(floor, list - (list - floor) * 0.5 * round));
  return { message: `Na pure handmade work o. Best I fit do is $${counter}.`, offerUsd: counter, accept: false };
}

// ---------------- 4. Buyer shopping agent ----------------

const AGENT_SYSTEM = `You are a shopping agent working for a buyer abroad who wants authentic products from small Nigerian sellers on the Snap & Sell store.
Rules:
- Use the tools. Never invent products, prices or stock.
- Recommend at most 3 items, each with its price in USD and a one-line reason.
- When the buyer wants a better price or says "negotiate"/"haggle"/"get me a deal", call negotiate_price with their budget. Report the result honestly.
- Only call start_checkout after the buyer has clearly chosen a product and asked to buy it. Pass deal_id if a negotiation agreed a price.
- If the conversation already contains a deal id (deal_...) for that product, do NOT negotiate again: call start_checkout with that deal_id straight away.
- start_checkout does NOT take money. It creates a PayPal checkout the buyer approves. After approval PayPal HOLDS the money and only releases it to the seller once the seller's parcel photo is verified. Say this plainly and briefly.
- Respect the buyer's budget. If nothing fits, say so.
- Keep replies short and friendly. Plain text, no markdown tables.`;

/**
 * Run one turn of the buyer agent with tool calling.
 * @param {Array<{role:string, content:string}>} history prior user/assistant messages
 * @param {{definitions: object[], run: (name:string, args:object)=>Promise<object>}} tools
 * @param {{onStep?: (step:object)=>void, maxSteps?: number}} opts
 */
export async function runShoppingAgent(history, tools, { maxSteps = 6, onStep = () => {} } = {}) {
  if (modes.aiMock) return mockAgent(history, tools, onStep);

  // Full history every turn (stored responses can expire, so we don't rely on them).
  const input = history.map((m) => ({
    type: 'message',
    role: m.role,
    content: [{ type: m.role === 'assistant' ? 'output_text' : 'input_text', text: m.content }],
  }));
  const steps = [];
  for (let i = 0; i < maxSteps; i++) {
    const res = await responses({ instructions: AGENT_SYSTEM, input, tools: tools.definitions, reasoning: { effort: 'low' } }, { timeoutMs: 25_000, retries: 2 });
    const calls = (res.output || []).filter((o) => o.type === 'function_call');
    if (!calls.length) return { reply: outputText(res) || '', steps, model: config.ai.model };

    input.push(...calls.map(({ type, call_id, name, arguments: args }) => ({ type, call_id, name, arguments: args })));
    for (const call of calls) {
      let args = {};
      try {
        args = JSON.parse(call.arguments || '{}');
      } catch {
        /* keep empty */
      }
      onStep({ tool: call.name, args, status: 'running' });
      const result = await tools.run(call.name, args);
      const step = { tool: call.name, args, result };
      steps.push(step);
      onStep(step);
      input.push({ type: 'function_call_output', call_id: call.call_id, output: JSON.stringify(result).slice(0, 12_000) });
    }
  }
  return { reply: 'I took too many steps on that one. Could you rephrase what you are looking for?', steps, model: config.ai.model };
}

// Deterministic stand-in so the flow can be tested without a Meta key.
async function mockAgent(history, tools, onStep) {
  const model = 'demo-mock (no Meta key set)';
  const last = [...history].reverse().find((m) => m.role === 'user')?.content || '';
  const t = last.toLowerCase();
  const steps = [];
  const call = async (tool, args) => {
    onStep({ tool, args, status: 'running' });
    const result = await tools.run(tool, args);
    const step = { tool, args, result };
    steps.push(step);
    onStep(step);
    return result;
  };
  const budget = Number((t.match(/\$\s?(\d+)|under (\d+)|below (\d+)/) || []).slice(1).find(Boolean)) || undefined;
  const idMatch = t.match(/(prd_[a-f0-9]{10})/);
  const dealMatch = [...history].reverse().map((m) => m.content.match(/(deal_[a-f0-9]{10})/)).find(Boolean);
  const pick = async () => {
    if (idMatch) return idMatch[1];
    const q = t.replace(/\b(buy|checkout|order|the|it|please|negotiate|haggle|get|me|a|deal|for|price|better|on)\b/g, ' ').replace(/\$?\d+/g, ' ');
    const found = await tools.run('search_products', { query: q });
    return found.products?.[0]?.id;
  };

  if (/\b(negotiate|haggle|deal|discount|better price)\b/.test(t) && !/\bbuy\b/.test(t)) {
    const productId = await pick();
    if (!productId) return { reply: 'Which item should I negotiate for?', steps, model };
    const r = await call('negotiate_price', { product_id: productId, max_price_usd: budget || 9999 });
    const reply = r.agreed
      ? `Good news: the seller's agent agreed to $${r.priceUsd} (list $${r.listPriceUsd}). Deal ${r.dealId} is held for 30 minutes. Say "buy it" and I'll prepare the PayPal checkout.`
      : `We couldn't agree within your budget. ${r.error || ''}`;
    return { reply, steps, model };
  }

  if (/\b(buy|checkout|order|yes)\b/.test(t)) {
    const productId = await pick();
    if (!productId) return { reply: 'Which item would you like to buy?', steps, model };
    const r = await call('start_checkout', { product_id: productId, quantity: 1, ...(dealMatch ? { deal_id: dealMatch[1] } : {}) });
    const reply = r.error
      ? `I couldn't start checkout: ${r.error}`
      : `Done. I created a PayPal checkout for ${r.title} ($${r.total}). Nothing is charged yet: approve it on PayPal, and PayPal holds the money until the seller's parcel photo is verified.`;
    return { reply, steps, model };
  }

  const r = await call('search_products', { query: last.replace(/\$?\d+/g, ' '), max_price_usd: budget });
  const items = r.products || [];
  const reply = items.length
    ? `I found ${items.length} option${items.length > 1 ? 's' : ''}:\n` +
      items.map((p) => `• ${p.title}: $${p.priceUsd} (${p.id})`).join('\n') +
      `\nWant me to negotiate a better price, or buy one?`
    : `I couldn't find anything matching that${budget ? ` under $${budget}` : ''}. Try another description?`;
  return { reply, steps, model };
}

export async function healthCheck() {
  if (modes.aiMock) return { ok: true, mode: 'mock' };
  try {
    await responses({ input: 'Reply with OK', reasoning: { effort: 'minimal' } }, { retries: 0, timeoutMs: 20_000 });
    return { ok: true, mode: 'live', model: config.ai.model };
  } catch (e) {
    return { ok: false, mode: 'live', error: e.message };
  }
}
