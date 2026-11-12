// Tapnod backend: serves the landing page and customer app, and the API for the POS and the customer.
// Plain Node 18+. The only package is `pg`, used when DATABASE_URL is set.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const push = require('./push');
const tts = require('./tts');
const auth = require('./auth');
const calls = require('./calls');
const atcalls = require('./atcalls');
const twcalls = require('./twcalls');
const i18n = require('./public/i18n');

const PORT = process.env.PORT || 3000;
// Must match "Card token secret" in the POS settings (the POS default is the same).
const TOKEN_SECRET = process.env.TOKEN_SECRET || 'tapnod-demo-secret';
// Signs sign-in sessions and keeps notification keys stable. Render generates it.
const APP_SECRET = process.env.VAPID_SECRET || TOKEN_SECRET;
// Demo shortcut for cards the server has never seen:
//   "latest" (default) = link the card to the most recently signed-up customer
//   a customer id      = link it to that customer
//   empty              = real behaviour, the POS shows "Card not linked"
const DEMO_AUTO_LINK = process.env.DEMO_AUTO_LINK ?? 'demo';
// Demo customer, created on start so the demo phone needs no sign-up. Set DEMO_CUSTOMER=off to disable.
const DEMO_ON = (process.env.DEMO_CUSTOMER || 'on') !== 'off';
const DEMO = { id: 'cus_demo_amaka', tapnod_id: 'TN-0001-AO', name: 'Amaka Okafor', account_number: '0123456789', pin: '1234' };
const REQUEST_TTL_MS = 120_000;
// Phone number the POS rings for the demo customer when none is typed (e.g. 08031234567).
const DEMO_PHONE = process.env.DEMO_PHONE || '';
// Phone calls: pressing 1 approves. Set CALL_REQUIRE_PIN=on to also ask for the 4-digit PIN.
const CALL_PIN = process.env.CALL_REQUIRE_PIN === 'on';
const LANGS = Object.keys(i18n.LANGS);

const vapid = push.vapidFromSecret(APP_SECRET);
const sessions = auth.sessions(APP_SECRET);
const requests = new Map(); // payment requests live 2 minutes, memory is enough

/* ---------------- helpers ---------------- */

function send(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; if (raw.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve(null); } });
  });
}

// The website as the phone sees it, for fingerprint checks. Render terminates https in front of us.
function siteOf(req) {
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'localhost').split(',')[0].trim();
  const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  return { origin: `${proto}://${host}`, rpId: host.replace(/:\d+$/, '') };
}

const STATIC = {
  '/': ['landing.html', 'text/html; charset=utf-8'],
  '/app': ['app.html', 'text/html; charset=utf-8'],
  '/demo': ['app.html', 'text/html; charset=utf-8'],
  '/pos': ['pos.html', 'text/html; charset=utf-8'],
  '/tapnod.css': ['tapnod.css', 'text/css; charset=utf-8'],
  '/i18n.js': ['i18n.js', 'application/javascript; charset=utf-8'],
  '/sw.js': ['sw.js', 'application/javascript; charset=utf-8'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
  '/icon.svg': ['icon.svg', 'image/svg+xml'],
};

function newTapnodId() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const n = String(crypto.randomInt(0, 10000)).padStart(4, '0');
  return `TN-${n}-${letters[crypto.randomInt(letters.length)]}${letters[crypto.randomInt(letters.length)]}`;
}

const mask = (acct) => '••••' + String(acct).slice(-4);

// What the customer's own app may see about her.
const publicCustomer = (c) => ({
  id: c.id, tapnod_id: c.tapnod_id, name: c.name, account_masked: mask(c.account_number),
  phone: c.phone, prefs: { lang: c.lang, voice: c.voice },
});

function refresh(r) {
  if (r.status === 'pending' && Date.now() > r.expires_at_ms) r.status = 'expired';
  return r;
}

function forCustomer(r, c) {
  const audio = r.audio && c && r.audio.key === c.lang + '|' + c.voice ? r.audio.url : null;
  return {
    request_id: r.request_id, status: r.status, amount_kobo: r.amount_kobo, currency: r.currency,
    merchant_name: r.merchant_name, card_last4: r.card_last4, card_scheme: r.card_scheme,
    reference: r.reference, expires_at_ms: r.expires_at_ms, audio_url: audio,
  };
}

async function signedInCustomer(req) {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const id = sessions.read(token);
  return id ? db.getCustomer(id) : null;
}

/* ---------------- side effects when a charge arrives ---------------- */

async function notify(r, c) {
  const subs = await db.subscriptionsFor(c.id);
  if (!subs.length) return;
  const a = i18n.moneyText(r.amount_kobo);
  const data = {
    title: i18n.t(c.lang, 'notifTitle', { a, m: r.merchant_name }),
    body: i18n.t(c.lang, 'notifBody'),
    request_id: r.request_id,
    url: '/app',
  };
  await Promise.all(subs.map(async (sub) => {
    try {
      const status = await push.send(sub, data, vapid);
      if (status === 404 || status === 410) await db.deleteSubscription(sub.endpoint);
      else if (status >= 400) console.warn('push failed', status);
    } catch (e) { console.warn('push error', e.message); }
  }));
}

async function prepareAudio(r, c) {
  if (!tts.enabled()) return;
  try {
    const url = await tts.speak(i18n.sayFor(c.lang, 'pending', r).spoken, c.voice || undefined);
    r.audio = { key: c.lang + '|' + c.voice, url };
  } catch (e) { console.warn('voice failed', e.message); }
}

/* ---------------- routes ---------------- */

async function route(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname.replace(/\/+$/, '') || '/';
  const m = req.method;
  let match;

  // Old customer links (/?c=...) go to the app.
  if (m === 'GET' && p === '/' && url.searchParams.has('c')) {
    res.writeHead(302, { Location: '/app' });
    return res.end();
  }
  if (m === 'GET' && STATIC[p]) {
    const [file, type] = STATIC[p];
    const headers = { 'Content-Type': type, 'Cache-Control': 'no-cache' };
    if (file === 'sw.js') headers['Service-Worker-Allowed'] = '/';
    res.writeHead(200, headers);
    return res.end(fs.readFileSync(path.join(__dirname, 'public', file)));
  }

  if (m === 'GET' && (p === '/api/health' || p === '/healthz')) return send(res, 200, { ok: true, storage: db.kind });

  // The demo phone: signs straight in as the demo customer (no sign-up on stage).
  if (m === 'POST' && p === '/api/demo/session') {
    if (!DEMO_ON) return send(res, 404, { message: 'Demo mode is off.' });
    const c = await db.getCustomer(DEMO.id);
    if (!c) return send(res, 404, { message: 'Demo customer missing.' });
    return send(res, 200, { token: sessions.issue(c.id, 365), customer: publicCustomer(c) });
  }

  if (m === 'GET' && p === '/api/config') {
    return send(res, 200, { push_public_key: vapid.publicKey, nigerian_voices: tts.enabled(), languages: LANGS });
  }

  if (m === 'GET' && p === '/api/voices') {
    try { return send(res, 200, { voices: await tts.voices() }); }
    catch (e) { return send(res, 502, { message: e.message, voices: [] }); }
  }

  if (m === 'POST' && p === '/api/tts') {
    const b = await readJson(req);
    if (!tts.enabled()) return send(res, 503, { message: 'Nigerian voices are not switched on (no YarnGPT key).' });
    if (!b || typeof b.text !== 'string' || !b.text.trim() || b.text.length > 300) {
      return send(res, 400, { message: 'Text is required (max 300 characters).' });
    }
    try { return send(res, 200, { audio_url: await tts.speak(b.text, b.voice || undefined) }); }
    catch (e) { return send(res, 502, { message: e.message }); }
  }

  /* ---------- accounts ---------- */

  if (m === 'POST' && p === '/api/auth/signup') {
    const b = await readJson(req);
    const name = String(b?.name || '').trim().slice(0, 80);
    const account = String(b?.account_number || '').replace(/\s/g, '');
    const phone = String(b?.phone || '').replace(/[^\d+]/g, '').slice(0, 16);
    // A 4-digit app PIN, like Cowrywise and most Nigerian banking apps. (A longer password still works.)
    const password = String(b?.pin ?? b?.password ?? '');
    if (name.length < 2) return send(res, 400, { message: 'Enter your full name.', field: 'name' });
    if (!/^\d{10}$/.test(account)) return send(res, 400, { message: 'Account number must be 10 digits.', field: 'account_number' });
    if (!/^\d{4}$/.test(password) && password.length < 6) return send(res, 400, { message: 'Your PIN must be 4 digits.', field: 'pin' });
    const lang = LANGS.includes(b?.lang) ? b.lang : 'en';
    let c = null;
    for (let i = 0; i < 5 && !c; i++) {
      try {
        c = await db.createCustomer({
          id: 'cus_' + crypto.randomBytes(6).toString('hex'), tapnod_id: newTapnodId(), name,
          account_number: account, phone, password_hash: auth.hashPassword(password),
          lang, voice: '', created_at: Date.now(),
        });
      } catch (e) {
        if (e.code !== 'DUPLICATE') throw e;
        if (await db.getCustomerByAccount(account)) {
          return send(res, 409, { message: 'This account number already has Tapnod. Sign in instead.', field: 'account_number' });
        }
        // otherwise the random Tapnod ID clashed; try another
      }
    }
    if (!c) return send(res, 500, { message: 'Could not create the account. Try again.' });
    return send(res, 201, { token: sessions.issue(c.id), customer: publicCustomer(c) });
  }

  if (m === 'POST' && p === '/api/auth/login') {
    const b = await readJson(req);
    const c = await db.getCustomerByAccount(String(b?.account_number || '').replace(/\s/g, ''));
    if (!c || !auth.checkPassword(String(b?.pin ?? b?.password ?? ''), c.password_hash)) {
      return send(res, 401, { message: 'Account number or PIN is wrong.' });
    }
    return send(res, 200, { token: sessions.issue(c.id), customer: publicCustomer(c) });
  }

  // Fingerprint sign-in, step 1: a challenge. No account number needed: the passkey says who you are.
  if (m === 'POST' && p === '/api/auth/passkey/login/options') {
    const ch = auth.newChallenge('login');
    return send(res, 200, { challenge_id: ch.id, challenge: ch.challenge, rp_id: siteOf(req).rpId });
  }

  // Fingerprint sign-in, step 2: check the signature.
  if (m === 'POST' && p === '/api/auth/passkey/login') {
    const b = await readJson(req);
    const ch = auth.takeChallenge(b?.challenge_id, 'login');
    if (!ch) return send(res, 400, { message: 'Sign-in expired. Try again.' });
    const cred = await db.getCredential(String(b?.id || ''));
    if (!cred) return send(res, 401, { message: 'This fingerprint isn\'t registered with Tapnod. Sign in with your account number.' });
    try {
      const { origin, rpId } = siteOf(req);
      auth.verifyAssertion(b, cred, ch.challenge, origin, rpId);
    } catch (e) {
      if (e instanceof auth.WebAuthnError) return send(res, 401, { message: e.message });
      throw e;
    }
    const c = await db.getCustomer(cred.customer_id);
    return send(res, 200, { token: sessions.issue(c.id), customer: publicCustomer(c) });
  }

  /* ---------- the signed-in customer ---------- */

  if (p.startsWith('/api/me') || p.startsWith('/api/customer/requests/')) {
    const c = await signedInCustomer(req);
    if (!c) return send(res, 401, { message: 'Please sign in.' });

    if (m === 'GET' && p === '/api/me') {
      const creds = await db.credentialsFor(c.id);
      return send(res, 200, { customer: publicCustomer(c), has_fingerprint: creds.length > 0 });
    }

    if (m === 'GET' && p === '/api/me/latest') {
      let latest = null;
      for (const r of requests.values()) {
        if (r.customer_id === c.id && (!latest || r.created_at_ms > latest.created_at_ms)) latest = r;
      }
      return send(res, 200, { request: latest ? forCustomer(refresh(latest), c) : null });
    }

    if (m === 'POST' && p === '/api/me/prefs') {
      const b = await readJson(req);
      const lang = LANGS.includes(b?.lang) ? b.lang : c.lang;
      const voice = typeof b?.voice === 'string' ? b.voice.slice(0, 64) : c.voice;
      await db.updatePrefs(c.id, lang, voice);
      return send(res, 200, { prefs: { lang, voice } });
    }

    if (m === 'POST' && p === '/api/me/subscribe') {
      const b = await readJson(req);
      const s = b && b.subscription;
      if (!s || typeof s.endpoint !== 'string' || !/^https:\/\//.test(s.endpoint) || !s.keys || !s.keys.p256dh || !s.keys.auth) {
        return send(res, 400, { message: 'Bad subscription.' });
      }
      await db.saveSubscription(c.id, { endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } });
      return send(res, 200, { ok: true });
    }

    if (m === 'POST' && p === '/api/me/test-notification') {
      const subs = await db.subscriptionsFor(c.id);
      if (!subs.length) return send(res, 409, { message: 'Notifications are not set up on this phone yet.' });
      const results = await Promise.all(subs.map((s) =>
        push.send(s, { title: 'Tapnod', body: i18n.t(c.lang, 'sample'), url: '/app' }, vapid).catch(() => 0)));
      return send(res, 200, { sent: results.filter((x) => x >= 200 && x < 300).length });
    }

    // Add a fingerprint to this account, step 1.
    if (m === 'POST' && p === '/api/me/passkey/options') {
      const ch = auth.newChallenge('register', { customer_id: c.id });
      const existing = await db.credentialsFor(c.id);
      return send(res, 200, {
        challenge_id: ch.id, challenge: ch.challenge, rp_id: siteOf(req).rpId,
        user: { id: auth.b64u.enc(Buffer.from(c.id)), name: c.tapnod_id, display_name: c.name },
        exclude: existing.map((x) => x.id),
      });
    }

    // Step 2: store the passkey's public key.
    if (m === 'POST' && p === '/api/me/passkey') {
      const b = await readJson(req);
      const ch = auth.takeChallenge(b?.challenge_id, 'register');
      if (!ch || ch.customer_id !== c.id) return send(res, 400, { message: 'Setup expired. Try again.' });
      try {
        const { origin, rpId } = siteOf(req);
        const cred = auth.verifyRegistration(b, ch.challenge, origin, rpId);
        await db.addCredential({ ...cred, customer_id: c.id, created_at: Date.now() });
      } catch (e) {
        if (e instanceof auth.WebAuthnError) return send(res, 400, { message: e.message });
        throw e;
      }
      return send(res, 201, { ok: true });
    }

    // Approving a payment, step 1: a challenge tied to this payment.
    if (m === 'POST' && (match = p.match(/^\/api\/customer\/requests\/([\w-]+)\/approve\/options$/))) {
      const r = requests.get(match[1]);
      if (!r || r.customer_id !== c.id) return send(res, 404, { message: 'Payment not found.' });
      const creds = await db.credentialsFor(c.id);
      if (!creds.length) return send(res, 409, { message: 'Set up your fingerprint first (Settings).' });
      const ch = auth.newChallenge('approve', { customer_id: c.id, request_id: r.request_id });
      return send(res, 200, { challenge_id: ch.id, challenge: ch.challenge, rp_id: siteOf(req).rpId, allow: creds.map((x) => x.id) });
    }

    // Step 2: the fingerprint signature approves the payment. Decline needs no fingerprint.
    if (m === 'POST' && (match = p.match(/^\/api\/customer\/requests\/([\w-]+)\/(approve|decline)$/))) {
      const r = requests.get(match[1]);
      if (!r || r.customer_id !== c.id) return send(res, 404, { message: 'Payment not found.' });
      if (refresh(r).status !== 'pending') {
        return send(res, 409, { message: 'This payment is already ' + r.status + '.', request: forCustomer(r, c) });
      }
      const b = match[2] === 'approve' ? await readJson(req) : null;
      // Password approval: for phones without a biometric, or when it misbehaves.
      if (b && (b.pin !== undefined || b.password !== undefined)) {
        if (!auth.checkPassword(String(b.pin ?? b.password), c.password_hash)) return send(res, 401, { message: 'Wrong PIN. Try again.' });
      } else if (b) {
        const ch = auth.takeChallenge(b?.challenge_id, 'approve');
        if (!ch || ch.request_id !== r.request_id || ch.customer_id !== c.id) {
          return send(res, 400, { message: 'Approval expired. Try again.' });
        }
        const cred = await db.getCredential(String(b?.id || ''));
        if (!cred || cred.customer_id !== c.id) return send(res, 401, { message: 'That fingerprint isn\'t on this account.' });
        try {
          const { origin, rpId } = siteOf(req);
          auth.verifyAssertion(b, cred, ch.challenge, origin, rpId);
        } catch (e) {
          if (e instanceof auth.WebAuthnError) return send(res, 401, { message: e.message });
          throw e;
        }
      }
      r.status = match[2] === 'approve' ? 'approved' : 'declined';
      return send(res, 200, { request: forCustomer(r, c) });
    }

    return send(res, 404, { message: 'Not found.' });
  }

  /* ---------- POS ---------- */

  if (m === 'GET' && p === '/api/pos/customers') {
    const list = await db.listCustomers();
    return send(res, 200, {
      customers: list.map((c) => ({ id: c.id, name: c.name, note: `${c.tapnod_id} · acct ${mask(c.account_number)}` })),
    });
  }

  if (m === 'POST' && p === '/api/pos/cards/link') {
    const b = await readJson(req);
    const c = b && b.customer_id ? await db.getCustomer(b.customer_id) : null;
    if (!b || !b.card_token || !c) return send(res, 400, { message: 'Pick a customer and tap a card.' });
    await db.linkCard(b.card_token, c.id);
    return send(res, 200, { ok: true });
  }

  // A charge, either from a card read (card_token) or from picking the customer on the POS (customer_id).
  if (m === 'POST' && p === '/api/pos/requests') {
    const b = await readJson(req);
    if (!b || !Number.isInteger(b.amount_kobo) || b.amount_kobo <= 0 || (!b.card_token && !b.customer_id)) {
      return send(res, 400, { message: 'Amount and a card or customer are required.' });
    }
    let customer = null;
    if (b.customer_id) {
      customer = await db.getCustomer(b.customer_id);
      if (!customer) return send(res, 404, { message: 'That customer is not on Tapnod.' });
    } else {
      const owner = await db.cardOwner(b.card_token);
      if (owner) customer = await db.getCustomer(owner);
      if (!customer && DEMO_AUTO_LINK) {
        customer = DEMO_AUTO_LINK === 'latest' ? (await db.listCustomers())[0]
          : await db.getCustomer(DEMO_AUTO_LINK === 'demo' ? DEMO.id : DEMO_AUTO_LINK);
        if (customer) await db.linkCard(b.card_token, customer.id);
      }
      if (!customer) return send(res, 404, { error: 'card_not_linked', message: 'Card not linked to Tapnod.' });
    }

    for (const r of requests.values()) {
      if (r.customer_id === customer.id && r.status === 'pending') r.status = 'cancelled';
    }
    const id = 'req_' + crypto.randomBytes(4).toString('hex');
    const r = {
      request_id: id, customer_id: customer.id, amount_kobo: b.amount_kobo, currency: b.currency || 'NGN',
      merchant_name: b.merchant_name || 'Merchant', terminal_id: b.terminal_id || req.headers['x-terminal-id'] || '',
      card_last4: b.card_last4 || '', card_scheme: b.card_scheme || '',
      status: 'pending', reference: 'TPN-' + id.slice(-6).toUpperCase(),
      created_at_ms: Date.now(), expires_at_ms: Date.now() + REQUEST_TTL_MS, audio: null,
    };
    requests.set(id, r);
    for (const [k, old] of requests) if (Date.now() - old.created_at_ms > 3600_000) requests.delete(k);
    notify(r, customer);
    prepareAudio(r, customer);
    return send(res, 201, { request_id: id, customer_name: customer.name, expires_at_ms: r.expires_at_ms });
  }

  if (m === 'GET' && (match = p.match(/^\/api\/pos\/requests\/([\w-]+)$/))) {
    const r = requests.get(match[1]);
    if (!r) return send(res, 404, { message: 'Request not found.' });
    refresh(r);
    return send(res, 200, { status: r.status, reference: r.reference, call: r.call ? r.call.status : null });
  }

  // Ask for approval by phone call instead: LiveKit rings the customer and she types her PIN on the keypad.
  if (m === 'POST' && (match = p.match(/^\/api\/pos\/requests\/([\w-]+)\/call$/))) {
    const r = requests.get(match[1]);
    if (!r || refresh(r).status !== 'pending') return send(res, 409, { message: 'This payment is no longer waiting.' });
    if (!calls.enabled() && !atcalls.enabled() && !twcalls.enabled()) return send(res, 503, { message: 'Phone calls are not set up on this server yet.' });
    const b = (await readJson(req)) || {};
    const c = await db.getCustomer(r.customer_id);
    const phone = calls.normalisePhone(b.phone || (c && c.phone) || (c && c.id === DEMO.id ? DEMO_PHONE : ''));
    if (!phone) return send(res, 400, { message: 'Type the customer\'s phone number, like 0803 123 4567.' });
    const room = 'tapnod-call-' + r.request_id;
    r.call = { status: 'calling', phone, tries: 0, origin: (process.env.PUBLIC_URL || siteOf(req).origin).replace(/\/+$/, '') };
    if (twcalls.enabled()) {
      const t = atcalls.stepToken(APP_SECRET, r.request_id);
      const base = `${r.call.origin}/api/tw/voice?r=${r.request_id}&t=${t}`;
      try {
        r.call.session = await twcalls.dial(phone, base + '&step=start', `${r.call.origin}/api/tw/status?r=${r.request_id}&t=${t}`);
      } catch (e) {
        console.warn('call failed', e.message);
        r.call.status = 'failed';
        return send(res, 502, { message: 'Couldn\'t start the call: ' + e.message });
      }
      return send(res, 200, { ok: true, phone: calls.maskPhone(phone) });
    }
    if (atcalls.enabled()) {
      try {
        r.call.session = await atcalls.dial(phone, r.request_id);
      } catch (e) {
        console.warn('call failed', e.message);
        r.call.status = 'failed';
        return send(res, 502, { message: 'Couldn\'t start the call. Check the Africa\'s Talking settings and balance.' });
      }
      return send(res, 200, { ok: true, phone: calls.maskPhone(phone) });
    }
    try {
      await calls.dial(room, {
        request_id: r.request_id,
        call_token: calls.callToken(APP_SECRET, r.request_id),
        callback: siteOf(req).origin + '/api/voice/requests/' + r.request_id,
        phone,
        first_name: String((c && c.name) || '').split(' ')[0],
        merchant: r.merchant_name,
        amount_words: i18n.moneyWords(r.amount_kobo),
      });
    } catch (e) {
      console.warn('call failed', e.message);
      r.call.status = 'failed';
      return send(res, 502, { message: 'Couldn\'t start the call. Check the LiveKit settings.' });
    }
    return send(res, 200, { ok: true, phone: calls.maskPhone(phone) });
  }

  // Africa's Talking asks what to do on the call. Set this as the voice number's callback URL:
  //   https://<your-site>/api/at/voice
  if (m === 'POST' && p === '/api/at/voice') {
    const f = await atcalls.readForm(req);
    const out = (inner) => { res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8' }); res.end(atcalls.xml(inner)); };
    // Which payment is this call about? Our own id (clientRequestId), the session, or the number we rang.
    let r = requests.get(url.searchParams.get('r') || f.clientRequestId || '');
    if (!r) {
      const nums = [f.destinationNumber, f.callerNumber, f.clientDialedNumber].filter(Boolean).map(calls.normalisePhone);
      r = [...requests.values()].reverse().find((x) => x.call && (x.call.session === f.sessionId || nums.includes(x.call.phone)));
    }
    if (!r || !r.call) return out(atcalls.say('Sorry, there is no Tapnod payment waiting for you. Goodbye.'));
    if (f.isActive === '0') {
      if (['calling', 'answered'].includes(r.call.status)) r.call.status = r.call.status === 'calling' ? 'failed' : 'ended';
      return out('');
    }
    const step = url.searchParams.get('step') || 'start';
    if (step !== 'start' && !atcalls.checkStepToken(APP_SECRET, r.request_id, url.searchParams.get('t'))) return out(atcalls.say('Goodbye.'));
    const next = (st) => `${r.call.origin}/api/at/voice?r=${r.request_id}&step=${st}&t=${atcalls.stepToken(APP_SECRET, r.request_id)}`;
    return out(await voiceStep(r, step, f.dtmfDigits, atcalls, next));
  }

  // Twilio fetches what to say from here. Every URL we give Twilio carries the payment id and a signed token.
  if (m === 'POST' && (p === '/api/tw/voice' || p === '/api/tw/status')) {
    const f = await atcalls.readForm(req);
    const r = requests.get(url.searchParams.get('r') || '');
    const out = (inner) => { res.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' }); res.end(twcalls.xml(inner)); };
    if (!r || !r.call || !atcalls.checkStepToken(APP_SECRET, r.request_id, url.searchParams.get('t'))) return out(twcalls.say('Goodbye.'));
    if (p === '/api/tw/status') {
      const st = String(f.CallStatus || '');
      if (st === 'in-progress' && r.call.status === 'calling') r.call.status = 'answered';
      if (['busy', 'no-answer', 'failed', 'canceled'].includes(st)) r.call.status = 'failed';
      if (st === 'completed' && ['calling', 'answered'].includes(r.call.status)) r.call.status = r.call.status === 'calling' ? 'failed' : 'ended';
      return out('');
    }
    const next = (st) => `${r.call.origin}/api/tw/voice?r=${r.request_id}&step=${st}&t=${atcalls.stepToken(APP_SECRET, r.request_id)}`;
    return out(await voiceStep(r, url.searchParams.get('step') || 'start', f.Digits, twcalls, next));
  }

  // The phone-call agent reports back here: call progress, and the customer's choice with her PIN.
  if (m === 'POST' && (match = p.match(/^\/api\/voice\/requests\/([\w-]+)$/))) {
    const r = requests.get(match[1]);
    const b = (await readJson(req)) || {};
    if (!r || !calls.checkCallToken(APP_SECRET, r.request_id, b.call_token)) return send(res, 403, { message: 'Not allowed.' });
    refresh(r);
    if (b.action === 'call_status' && r.call && ['answered', 'failed', 'ended'].includes(b.status)) r.call.status = b.status;
    if (b.action === 'approve' || b.action === 'decline') {
      if (r.status !== 'pending') return send(res, 409, { status: r.status });
      if (b.action === 'approve') {
        const c = await db.getCustomer(r.customer_id);
        if (CALL_PIN && (!c || !auth.checkPassword(String(b.pin || ''), c.password_hash))) return send(res, 401, { status: r.status, message: 'Wrong PIN.' });
      }
      r.status = b.action === 'approve' ? 'approved' : 'declined';
    }
    return send(res, 200, { status: r.status });
  }

  if (m === 'POST' && (match = p.match(/^\/api\/pos\/requests\/([\w-]+)\/cancel$/))) {
    const r = requests.get(match[1]);
    if (r && refresh(r).status === 'pending') r.status = 'cancelled';
    return send(res, 200, { ok: true });
  }

  send(res, 404, { message: 'Not found.' });
}

// One phone-call script for Africa's Talking and Twilio: read the payment, 1 = approve, 2 = decline, then the PIN.
async function voiceStep(r, step, rawDigits, kit, next) {
  const c = await db.getCustomer(r.customer_id);
  const amount = i18n.moneyWords(r.amount_kobo);
  const end = (text) => { r.call.status = 'ended'; return kit.say(text); };
  r.call.status = 'answered';
  if (refresh(r).status !== 'pending') {
    const words = { approved: 'approved', declined: 'declined', expired: 'timed out', cancelled: 'cancelled by the shop' };
    return end(`This payment has already been ${words[r.status] || r.status}. Goodbye.`);
  }
  const digits = String(rawDigits || '').replace(/[^\d]/g, '');
  const askChoice = (intro) => kit.getDigits(intro + 'To approve, press 1. To decline, press 2.', 1, next('choice'))
    + kit.say('I did not get an answer, so nothing was paid. Goodbye.');
  const askPin = (intro) => kit.getDigits(intro + 'Type your 4 digit Tapnod PIN now.', 4, next('pin'))
    + kit.say('I did not get your PIN, so nothing was paid. Goodbye.');

  if (step === 'start') {
    const name = String((c && c.name) || '').split(' ')[0] || 'there';
    return askChoice(`Hello ${name}. This is Tapnod. ${r.merchant_name} is asking you to pay ${amount}. `);
  }
  if (step === 'choice') {
    if (digits === '1') {
      if (CALL_PIN) return askPin('');
      r.status = 'approved';
      return end(`Payment approved. You paid ${amount} to ${r.merchant_name}. Thank you. Goodbye.`);
    }
    if (digits === '2') { r.status = 'declined'; return end('Payment declined. No money left your account. Goodbye.'); }
    return askChoice(`Again: ${r.merchant_name} is asking for ${amount}. `);
  }
  if (step === 'pin') {
    if (digits.length === 4 && c && auth.checkPassword(digits, c.password_hash)) {
      r.status = 'approved';
      return end(`Payment approved. You paid ${amount} to ${r.merchant_name}. Thank you. Goodbye.`);
    }
    r.call.tries += 1;
    if (r.call.tries >= 3) { r.status = 'declined'; return end('Too many wrong PINs, so the payment was declined. Goodbye.'); }
    const left = 3 - r.call.tries;
    return askPin(`That PIN is not correct. You have ${left} ${left === 1 ? 'try' : 'tries'} left. `);
  }
  return end('Goodbye.');
}

async function seedDemo() {
  if (!DEMO_ON || await db.getCustomer(DEMO.id)) return;
  // Someone already signed up with the demo account number: use that account as the demo customer.
  const existing = await db.getCustomerByAccount(DEMO.account_number);
  if (existing) { DEMO.id = existing.id; console.log(`Demo customer: ${existing.name} (existing account)`); return; }
  try {
    await db.createCustomer({
      id: DEMO.id, tapnod_id: DEMO.tapnod_id, name: DEMO.name, account_number: DEMO.account_number, phone: '',
      password_hash: auth.hashPassword(DEMO.pin), lang: 'en', voice: '', created_at: 1,
    });
    console.log(`Demo customer ready: ${DEMO.name}, account ${DEMO.account_number}, PIN ${DEMO.pin}`);
  } catch (e) { console.warn('Demo customer not created:', e.message); }
}

db.init().then(seedDemo).then(() => {
  http
    .createServer((req, res) => {
      route(req, res).catch((e) => {
        console.error(e);
        send(res, 500, { message: 'Something went wrong on Tapnod.' });
      });
    })
    .listen(PORT, () => {
      console.log(`Tapnod running on http://localhost:${PORT} (storage: ${db.kind})`);
      console.log(`Nigerian voices (YarnGPT): ${tts.enabled() ? 'on' : 'off, set YARNGPT_API_KEY to switch on'}`);
    });
}).catch((e) => {
  console.error('Could not start the database:', e.message);
  process.exit(1);
});
