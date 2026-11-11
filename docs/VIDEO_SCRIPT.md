# Demo video script (under 3 minutes)

Record your screen at 1080p with your voice, using the deployed app with real sandbox keys. No copyrighted music. Upload to YouTube as **Public**.

**Before recording:**
- Reset the demo data so the store is fresh. Locally, move `data/db.json` away and restart. On Render, restart the service: the disk is not kept, so it reseeds.
- Open these tabs: `/agent`, `/dashboard`, and PayPal sandbox logged out.
- Have one real product photo ready: anything you own, such as a bag, a fabric or a shoe.
- Zoom the browser to 110%.
- Do one full practice run first: the first model call after a deploy is slower.

| Time | On screen | What you say |
|---|---|---|
| 0:00–0:15 | Title card, then the store | "For about twenty years, Nigerians couldn't receive PayPal payments. Since January, they can. But why would a buyer in London trust a seller in Lagos they've never heard of? Snap & Sell builds that trust into every sale." |
| 0:15–0:40 | `/` Sell page: upload your photo, **Write my listing with AI**, show price reasoning and the private lowest price, **Publish** | "One photo. Meta's Muse Spark writes the listing and a fair dollar price, and explains it. The seller also sets a private lowest price for haggling. Publish, and it's live with a PayPal checkout, a QR code and a WhatsApp post." |
| 0:40–1:20 | `/agent`: tap the "get me a deal on the Ankara buckle tote, my max is $34" chip. Let the haggle play | "More shopping is moving to AI agents. My agent finds the bag, and then it haggles with the seller's own AI agent, Lagos-market style. The seller's lowest price never leaves the server, and the code clamps every offer. Deal at thirty-two dollars." |
| 1:20–1:45 | Tap **Buy it**, **Review & approve on PayPal**, log in with the sandbox buyer, approve. Land on the order page | "The agent can't pay. I approve on PayPal myself. Here's the key part: we use PayPal's authorize flow, so PayPal is holding my money. The seller isn't paid yet." |
| 1:45–2:25 | `/dashboard`: **Ship & get paid**, sample photo **✗ different item**. Show the red verdict. Then **✓ correct item**, show the green verdict | "Now the seller ships. They photograph the parcel with its waybill. Say they pack a cheaper bag. Muse Spark compares it with the listing: no buckle, different pattern. The money stays held. With the right bag, it matches, reads the tracking number and checks the name against PayPal's shipping details. The payment is captured, and the tracking is added to the PayPal order." |
| 2:25–2:45 | Order page: timeline all green, both photos | "The buyer sees the evidence and every step. If the seller had sent the wrong item, I could cancel and PayPal voids the hold. I'm never charged." |
| 2:45–3:00 | Back to the store | "Snap & Sell: agents haggle, PayPal holds the money, and AI checks the parcel. Trust for the world's newest PayPal sellers." |

**Tips:**
- Cut the model wait times in editing, but keep about one second so it's clear the processing is real.
- Say "sandbox" once.
- If you can, film the wrong-item moment with a real photo of a real swapped item. It lands harder than the sample.
