// Phone-call approvals through Vonage (free €2 trial credit, no card).
// Trial accounts may call the number you signed up with, using 123456789 as the caller ID.
// We start the call; Vonage fetches JSON instructions (an NCCO) from /api/vg/voice.

const crypto = require('crypto');

const APP_ID = process.env.VONAGE_APPLICATION_ID || '';
// The private key from the Vonage application. In env vars, \n may be written literally.
const KEY = (process.env.VONAGE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
const FROM = process.env.VONAGE_FROM || '123456789';
const API = process.env.VONAGE_API || 'https://api.nexmo.com';

const enabled = () => Boolean(APP_ID && KEY);
const b64url = (b) => Buffer.from(b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

function jwt() {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify({ application_id: APP_ID, iat: now, exp: now + 300, jti: crypto.randomUUID() }));
  const sig = crypto.sign('RSA-SHA256', Buffer.from(head + '.' + body), KEY);
  return `${head}.${body}.${b64url(sig)}`;
}

async function dial(to, answerUrl, eventUrl) {
  const res = await fetch(`${API}/v1/calls`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + jwt(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      to: [{ type: 'phone', number: String(to).replace(/^\+/, '') }],
      from: { type: 'phone', number: String(FROM).replace(/^\+/, '') },
      answer_url: [answerUrl], answer_method: 'POST',
      event_url: [eventUrl], event_method: 'POST',
      ringing_timer: 30,
    }),
    signal: AbortSignal.timeout(10000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Vonage ${res.status}: ${data.title || ''} ${data.detail || data.error_title || ''}`.trim());
  return data.uuid || '';
}

const say = (t) => ({ action: 'talk', text: t, language: 'en-GB' });
function getDigits(prompt, numDigits, eventUrl) {
  return [
    { action: 'talk', text: prompt, language: 'en-GB', bargeIn: true },
    { action: 'input', type: ['dtmf'], dtmf: { maxDigits: numDigits, timeOut: 10, submitOnHash: true }, eventUrl: [eventUrl], eventMethod: 'POST' },
  ];
}
// After an input action Vonage replaces the call script with our reply, so anything after it never plays.
const join = (items) => JSON.stringify(items.flat());

module.exports = { enabled, dial, say, getDigits, join, jwt };
