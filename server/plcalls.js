// Phone-call approvals through Plivo (free trial credit, no card). Same idea as Twilio:
// we start the call, Plivo fetches XML from /api/pl/voice: <Speak> the payment, <GetInput> 1 or 2.

const ID = process.env.PLIVO_AUTH_ID || '';
const TOKEN = process.env.PLIVO_AUTH_TOKEN || '';
const FROM = process.env.PLIVO_FROM || '';
const API = process.env.PLIVO_API || 'https://api.plivo.com';

const enabled = () => Boolean(ID && TOKEN && FROM);
const bare = (n) => String(n).replace(/^\+/, ''); // Plivo wants 2348031234567, no plus

async function dial(to, answerUrl, hangupUrl) {
  const res = await fetch(`${API}/v1/Account/${ID}/Call/`, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(`${ID}:${TOKEN}`).toString('base64'), 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: bare(FROM), to: bare(to), answer_url: answerUrl, answer_method: 'POST', hangup_url: hangupUrl, hangup_method: 'POST', ring_timeout: 30 }),
    signal: AbortSignal.timeout(10000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Plivo ${res.status}: ${data.error || data.message || JSON.stringify(data).slice(0, 200)}`);
  return data.request_uuid || '';
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const say = (t) => `<Speak>${esc(t)}</Speak>`;
const xml = (inner) => `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`;
function getDigits(prompt, numDigits, actionUrl) {
  return `<GetInput action="${esc(actionUrl)}" method="POST" inputType="dtmf" numDigits="${numDigits}" digitEndTimeout="5" executionTimeout="15" redirect="true">${say(prompt)}</GetInput>`;
}

module.exports = { enabled, dial, say, xml, getDigits };
