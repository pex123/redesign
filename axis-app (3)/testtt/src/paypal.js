// Real PayPal REST API integration (Orders v2 + Payouts).
//
// This talks to PayPal's actual API. For it to move real money into YOUR
// PayPal account, you must supply YOUR OWN credentials as environment
// variables — there is no way around this step, and no one but you can
// create them, because they're tied to your PayPal business account:
//
//   1. Go to https://developer.paypal.com/dashboard/ and log in with (or
//      create) your PayPal account. Business accounts unlock Payouts;
//      personal accounts can still receive Checkout payments.
//   2. Apps & Credentials → Create App. Copy the Client ID and Secret.
//   3. Set these env vars (in `.env` locally, or Render's Environment tab):
//        PAYPAL_CLIENT_ID=...
//        PAYPAL_CLIENT_SECRET=...
//        PAYPAL_MODE=sandbox        (use "sandbox" while testing with fake
//                                     money, "live" only once you're ready
//                                     for real transactions)
//
// Until those are set, every route in server.js that calls this module
// returns a clear 503 "PayPal not configured" error instead of silently
// pretending to charge someone — that's the "no fake code" requirement:
// it either really calls PayPal, or it tells you honestly that it can't yet.
//
// What each flow actually does once configured:
//  - createOrder/captureOrder (Orders v2, "Checkout"): the buyer pays with
//    their PayPal/card, and PayPal deposits that money directly into the
//    PayPal account tied to PAYPAL_CLIENT_ID — i.e. yours. This is how
//    ticket purchases and AXC top-ups turn into real money landing in your
//    PayPal balance.
//  - payout (Payouts API): sends real money OUT of that same PayPal balance
//    to a recipient's PayPal email. This is how a user "cashes out" AXC to
//    their own PayPal. Payouts requires your PayPal account to have Payouts
//    enabled (Business accounts qualify; PayPal may require a brief review
//    for first-time payout senders — that's PayPal's process, not something
//    any code can skip).

const BASE = process.env.PAYPAL_MODE === 'live'
  ? 'https://api-m.paypal.com'
  : 'https://api-m.sandbox.paypal.com';

function configured() {
  return !!(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET);
}

function requireConfigured() {
  if (!configured()) {
    const e = new Error('PayPal is not configured on this server yet. Set PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET (and optionally PAYPAL_MODE) as environment variables — see src/paypal.js for exact steps.');
    e.status = 503;
    throw e;
  }
}

let cachedToken = null; // { token, expiresAt }
async function getAccessToken() {
  requireConfigured();
  if (cachedToken && cachedToken.expiresAt > Date.now() + 30000) return cachedToken.token;

  const auth = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString('base64');
  const res = await fetch(`${BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials'
  });
  const data = await res.json();
  if (!res.ok) throw Object.assign(new Error(data.error_description || 'PayPal auth failed.'), { status: 502 });
  cachedToken = { token: data.access_token, expiresAt: Date.now() + (data.expires_in * 1000) };
  return cachedToken.token;
}

async function paypalFetch(path, opts = {}) {
  const token = await getAccessToken();
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(opts.headers || {}) }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.message || data.error_description || `PayPal request failed (${res.status}).`), { status: 502, detail: data });
  return data;
}

// Create a PayPal order for `amountUsd` — the buyer approves this on PayPal's
// site/app, then you call captureOrder with the returned order id.
async function createOrder(amountUsd, description) {
  requireConfigured();
  const data = await paypalFetch('/v2/checkout/orders', {
    method: 'POST',
    body: JSON.stringify({
      intent: 'CAPTURE',
      purchase_units: [{
        description: description || 'AXIS payment',
        amount: { currency_code: 'USD', value: Number(amountUsd).toFixed(2) }
      }]
    })
  });
  const approveLink = (data.links || []).find(l => l.rel === 'approve')?.href;
  return { orderId: data.id, approveUrl: approveLink, status: data.status };
}

// Capture a previously-approved order — this is the moment money actually
// moves into your PayPal account.
async function captureOrder(orderId) {
  requireConfigured();
  const data = await paypalFetch(`/v2/checkout/orders/${orderId}/capture`, { method: 'POST' });
  const capture = data.purchase_units?.[0]?.payments?.captures?.[0];
  return { status: data.status, captureId: capture?.id, amount: capture?.amount?.value, currency: capture?.amount?.currency_code };
}

// Send real money OUT to a recipient's PayPal email (Payouts API).
async function sendPayout(recipientEmail, amountUsd, note) {
  requireConfigured();
  const batchId = 'axis_payout_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  const data = await paypalFetch('/v1/payments/payouts', {
    method: 'POST',
    body: JSON.stringify({
      sender_batch_header: { sender_batch_id: batchId, email_subject: 'You have a payout from AXIS', email_message: note || 'AXC cash-out' },
      items: [{
        recipient_type: 'EMAIL',
        amount: { value: Number(amountUsd).toFixed(2), currency: 'USD' },
        receiver: recipientEmail,
        note: note || 'AXC cash-out',
        sender_item_id: batchId
      }]
    })
  });
  return { batchId: data.batch_header?.payout_batch_id, status: data.batch_header?.batch_status };
}

module.exports = { configured, createOrder, captureOrder, sendPayout };
