// Phone-call approvals through Twilio's Voice API (works on a free trial).
// 1. We ask Twilio to ring the customer (POST .../Calls.json) and give it our URL.
// 2. Twilio fetches TwiML from /api/tw/voice: <Say> the payment, <Gather> 1 or 2, then <Gather> her PIN.
// No packages: plain HTTPS and a little XML.

const SID = process.env.TWILIO_ACCOUNT_SID || '';
const TOKEN = process.env.TWILIO_AUTH_TOKEN || '';
const FROM = process.env.TWILIO_FROM || '';
const API = process.env.TWILIO_API || 'https://api.twilio.com';

const enabled = () => Boolean(SID && TOKEN && FROM);

// Twilio wants StatusCallbackEvent repeated once per event, not space-separated.
function callBody(to, url, statusUrl) {
  const b = new URLSearchParams({ To: to, From: FROM, Url: url, Method: 'POST', StatusCallback: statusUrl, StatusCallbackMethod: 'POST', Timeout: '30' });
  for (const ev of ['initiated', 'ringing', 'answered', 'completed']) b.append('StatusCallbackEvent', ev);
  return b.toString();
}

async function dial(to, url, statusUrl) {
  const res = await fetch(`${API}/2010-04-01/Accounts/${SID}/Calls.json`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${SID}:${TOKEN}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: callBody(to, url, statusUrl),
    signal: AbortSignal.timeout(10000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Twilio ${res.status}: ${data.code || ''} ${data.message || ''}`.trim());
  return data.sid || '';
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const say = (t) => `<Say>${esc(t)}</Say>`;
const xml = (inner) => `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`;
function getDigits(prompt, numDigits, actionUrl, timeout = 15) {
  return `<Gather input="dtmf" numDigits="${numDigits}" timeout="${timeout}" finishOnKey="#" action="${esc(actionUrl)}" method="POST">${say(prompt)}</Gather>`;
}

module.exports = { enabled, dial, say, xml, getDigits, callBody };
