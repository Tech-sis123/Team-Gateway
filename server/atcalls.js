// Phone-call approvals through Africa's Talking (Nigerian voice numbers).
// 1. We ask Africa's Talking to ring the customer (POST /call).
// 2. When she answers, Africa's Talking posts to /api/at/voice and we reply with XML:
//    <Say> the payment, <GetDigits> for 1 (approve) / 2 (decline), then <GetDigits> for her PIN.
// No packages: plain HTTPS and a little XML.

const crypto = require('crypto');

const USER = process.env.AT_USERNAME || '';
const KEY = process.env.AT_API_KEY || '';
const FROM = process.env.AT_VOICE_NUMBER || '';
const API = process.env.AT_VOICE_API || 'https://voice.africastalking.com/call';

const enabled = () => Boolean(USER && KEY && FROM);

async function dial(to, clientRequestId) {
  const res = await fetch(API, {
    method: 'POST',
    headers: { apiKey: KEY, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: USER, from: FROM, to, clientRequestId }).toString(),
    signal: AbortSignal.timeout(10000),
  });
  const text = await res.text();
  let data = {};
  try { data = JSON.parse(text); } catch {}
  const entry = (data.entries || [])[0] || {};
  if (!res.ok || (entry.status && entry.status !== 'Queued')) {
    throw new Error(`Africa's Talking ${res.status}: ${entry.status || data.errorMessage || text.slice(0, 200)}`);
  }
  return entry.sessionId || '';
}

// Africa's Talking posts form data.
function readForm(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 1e5) req.destroy(); });
    req.on('end', () => {
      const out = {};
      const type = String(req.headers['content-type'] || '');
      if (type.includes('json')) { try { Object.assign(out, JSON.parse(raw)); } catch {} }
      else for (const [k, v] of new URLSearchParams(raw)) out[k] = v;
      resolve(out);
    });
  });
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const say = (t) => `<Say voice="woman">${esc(t)}</Say>`;
const xml = (inner) => `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`;
function getDigits(prompt, numDigits, callbackUrl, timeout = 15) {
  return `<GetDigits timeout="${timeout}" numDigits="${numDigits}" finishOnKey="#" callbackUrl="${esc(callbackUrl)}">${say(prompt)}</GetDigits>`;
}

// Signs the callback URLs we hand out, so only calls we started can approve anything.
const stepToken = (secret, requestId) => crypto.createHmac('sha256', secret).update('at|' + requestId).digest('hex').slice(0, 32);
function checkStepToken(secret, requestId, token) {
  const want = Buffer.from(stepToken(secret, requestId));
  const got = Buffer.from(String(token || ''));
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

module.exports = { enabled, dial, readForm, xml, say, getDigits, stepToken, checkStepToken };
