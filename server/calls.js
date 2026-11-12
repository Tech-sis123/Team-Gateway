// Phone-call approvals through LiveKit.
// The server asks LiveKit to send the "tapnod-caller" agent (caller/agent.py) into a new room.
// The agent rings the customer, reads the payment, collects her PIN on the keypad
// and reports back to /api/voice/requests/{id}. No packages: LiveKit's API is plain HTTP + a signed token.

const crypto = require('crypto');

const URL_ = (process.env.LIVEKIT_URL || '').replace(/^wss:/, 'https:').replace(/^ws:/, 'http:').replace(/\/+$/, '');
const KEY = process.env.LIVEKIT_API_KEY || '';
const SECRET = process.env.LIVEKIT_API_SECRET || '';
const AGENT = process.env.CALL_AGENT_NAME || 'tapnod-caller';

const enabled = () => Boolean(URL_ && KEY && SECRET);

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

// A short-lived LiveKit access token that lets us create one room and send an agent into it.
function lkToken(room) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify({
    iss: KEY, sub: 'tapnod-server', nbf: now - 5, exp: now + 300,
    video: { room, roomCreate: true, roomAdmin: true },
  }));
  const sig = b64url(crypto.createHmac('sha256', SECRET).update(head + '.' + body).digest());
  return `${head}.${body}.${sig}`;
}

async function twirp(service, method, room, payload) {
  const res = await fetch(`${URL_}/twirp/livekit.${service}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + lkToken(room) },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`LiveKit ${method} ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
}

// Start the call: create the room, then dispatch the agent with everything it needs.
async function dial(room, metadata) {
  await twirp('RoomService', 'CreateRoom', room, { name: room, empty_timeout: 180 });
  await twirp('AgentDispatchService', 'CreateDispatch', room, { room, agent_name: AGENT, metadata: JSON.stringify(metadata) });
}

// Nigerian numbers: 0803 123 4567 -> +2348031234567. Anything already in +country form is kept.
function normalisePhone(raw) {
  let s = String(raw || '').replace(/[^\d+]/g, '');
  if (!s) return '';
  if (s.startsWith('+')) return /^\+\d{8,15}$/.test(s) ? s : '';
  if (s.startsWith('234')) s = '+' + s;
  else if (s.startsWith('0') && s.length === 11) s = '+234' + s.slice(1);
  else return '';
  return /^\+\d{8,15}$/.test(s) ? s : '';
}

const maskPhone = (p) => (p ? p.slice(0, 7) + ' ··· ' + p.slice(-2) : '');

// Each call carries a token only this server can make, so nobody else can approve through the voice endpoint.
const callToken = (secret, requestId) => crypto.createHmac('sha256', secret).update('call|' + requestId).digest('hex');
function checkCallToken(secret, requestId, token) {
  const want = Buffer.from(callToken(secret, requestId));
  const got = Buffer.from(String(token || ''));
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

module.exports = { enabled, dial, normalisePhone, maskPhone, callToken, checkCallToken, AGENT };
