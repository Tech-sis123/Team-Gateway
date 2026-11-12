# Tapnod

**Card payments a blind customer can trust.**

When a shop charges your card, Tapnod reads the payment out loud on your own phone: who is charging you and how much. Then the fingerprint prompt opens and you approve with one touch. You don't have to ask a stranger to read the POS screen for you, and you never have to say your PIN out loud.

Tapnod is built for blind and low-vision customers first. It also helps older customers, people who prefer their own language, and anyone who doesn't want to hand over their card and PIN.

**Live app:** https://team08.xtradot.co

| Page | Link | Who uses it |
| --- | --- | --- |
| Landing page | https://team08.xtradot.co | Anyone |
| POS | https://team08.xtradot.co/pos | The shop, on a laptop |
| Demo customer | https://team08.xtradot.co/demo | Amaka, the blind customer, on her phone |
| Customer app | https://team08.xtradot.co/app | Real customers: sign up and sign in |

## How a payment works

```text
 Shop (POS on a laptop)           Tapnod server                    Customer's phone
 ----------------------           -------------                    ----------------
 1. Types ₦15,000, presses
    Charge, card is tapped   ---> 2. Finds the card's owner,
    or scanned                       creates a payment request ---> 3. Reads it aloud:
                                     (2-minute timer)                 "Bisi Ventures is asking you
                                                                       to pay fifteen thousand naira"
                                                                   4. Fingerprint prompt opens
                                                                      by itself; she touches it
                                  5. Checks the fingerprint  <---
                                     signature, approves
 6. Shows "Payment approved"  <---
    and the receipt
```

The card number never leaves the POS. It becomes a one-way token (HMAC-SHA256) the moment it is read, and only the last 4 digits are shown.

## Features

- **Payments read aloud** in English, Nigerian Pidgin, Yorùbá, Igbo and Hausa.
- **Fingerprint or Face ID approval.** The fingerprint prompt opens as soon as the payment is read out. Any biometric the phone has works: fingerprint, Face ID, Touch ID or Windows Hello. These are WebAuthn passkeys, and the server checks each signature against a challenge made for that exact payment.
- **PIN fallback.** A big keypad for customers without a fingerprint. The voice says how many digits were typed, never which ones.
- **Phone notifications** (Web Push) that work even when the browser is closed.
- **Approval by phone call** for customers without a smartphone or data. The POS rings her, a voice reads the payment, and she presses 1 and types her PIN on the keypad. Works on any phone.
- **Laptop POS.** Keypad, card scan through the webcam, USB card reader support, or pick a customer by name. The POS stays silent, so only the customer hears the amount.
- **Nigerian voices** through YarnGPT when an API key is set. Otherwise the phone's own voice is used.

## Demo (laptop + Android phone)

1. **Laptop:** open https://team08.xtradot.co/pos.
2. **Phone:** open https://team08.xtradot.co/demo in Chrome. It signs in straight away as the demo customer, Amaka Okafor (account `0123456789`, PIN `1234`). Tap the screen once to turn on the voice. The first time, it also saves her fingerprint.
3. **Laptop:** type an amount, press **Charge**, then **Scan card** (hold any card up to the webcam) or **Card tapped**.
4. **Phone:** reads the payment aloud and the fingerprint prompt opens. Touch the sensor.
5. **Laptop:** shows **Payment approved** with the receipt. The phone goes back to waiting on its own.

Tips: keep Chrome open on the phone with the volume up, and put both devices on the same reliable network (a phone hotspot works well).

## Approval by phone call

For customers with a basic phone, or when the app isn't open. On the POS waiting screen, type her number (or leave it empty to use the one on her account) and press **Call her phone**.

```text
 POS: Call her phone ──> Tapnod server ──> LiveKit ──> caller agent ──> rings her phone
                                                         │
   "Hello Amaka. Bisi Ventures is asking you to pay fifteen thousand naira.
    To approve, press 1. To decline, press 2."   ->  1  ->  "Type your 4 digit Tapnod PIN"
                                                         │
 POS shows Approved <── Tapnod server checks the PIN <───┘
```

- The PIN is never read back, and she gets 3 tries.
- If she approves in the app while on the call, the call ends by itself.
- Each call carries a one-time code from the server, so nothing else can approve through the voice endpoint.

**Option 0: Twilio free trial (no card, 75 free minutes).** Simplest for one demo phone.

1. Sign up at twilio.com/try-twilio **with the Nigerian number you'll call** (it's verified automatically; trial calls only go to verified numbers in your sign-up country).
2. From the console, copy the **Account SID**, **Auth Token**, and the trial **From** number shown on Voice > Try out Voice.
3. Give the server `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` and `PUBLIC_URL=https://<your-site>`. Nothing to set in Twilio: each call tells Twilio where to fetch its script.

**Option 1: Africa's Talking (Nigerian number, cheapest).** No agent to deploy: the server does everything.

1. On africastalking.com (Live account, not Sandbox), request a Nigerian voice number: Voice, Phone numbers, request form, category **Test Number**.
2. Set the number's **callback URL** to `https://<your-site>/api/at/voice`.
3. Give the server `AT_USERNAME`, `AT_API_KEY` and `AT_VOICE_NUMBER` (e.g. `+234...`). Set `PUBLIC_URL=https://<your-site>` if your host doesn't pass https headers.

The POS uses Twilio if it's set, then Africa's Talking, then LiveKit (below).

**Option 2: LiveKit.** Set up (once):

1. In your [LiveKit Cloud](https://cloud.livekit.io) project, open **Telephony** and add an **outbound SIP trunk** from a provider that can call Nigerian numbers (for example Twilio or Telnyx). Copy its trunk ID (`ST_...`).
2. Deploy the agent in `caller/`:
   ```bash
   cd caller
   cp .env.example .env          # fill in the LiveKit keys, SIP_OUTBOUND_TRUNK_ID and DEEPGRAM_API_KEY
   lk agent create --secrets-file .env    # first time
   lk agent deploy                        # after changes
   ```
   To try it on your laptop instead: `pip install -r requirements.txt && python agent.py dev`.
3. Give the server the same LiveKit project: set `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` (and `DEMO_PHONE` for Amaka). On Kubernetes, create the `tapnod-calls` secret shown in `k8s/app.yaml`, then `kubectl rollout restart deployment/app`.

## Run it on your computer

You need Node.js 18 or newer.

```bash
cd server
npm install
node server.js
```

Then open http://localhost:3000. Data is kept in memory unless you set `DATABASE_URL`. Fingerprints only work over https or on `localhost`, so test them there and not on a `http://192.168...` address.

To keep data in Postgres:

```bash
DATABASE_URL=postgres://user:pass@host:5432/tapnod node server.js
```

The tables are created automatically on start.

### Environment variables

| Name | What it does |
| --- | --- |
| `PORT` | Port to listen on. Default `3000` (`8080` in Docker). |
| `DATABASE_URL` | Postgres connection. Without it, data lives in memory and resets on restart. |
| `DATABASE_SSL` | Set to `true` if your Postgres needs SSL. |
| `TOKEN_SECRET` | Key used to turn card numbers into tokens. Default `tapnod-demo-secret`. |
| `VAPID_SECRET` | Signs sessions and notification keys. Falls back to `TOKEN_SECRET`. |
| `YARNGPT_API_KEY` | Turns on Nigerian voices. |
| `DEMO_CUSTOMER` | Creates the demo customer Amaka on start. Set to `off` to disable. |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` | Phone calls through Twilio (used first when set). |
| `AT_USERNAME`, `AT_API_KEY`, `AT_VOICE_NUMBER` | Phone calls through Africa's Talking. |
| `PUBLIC_URL` | This site's public https address, for Twilio and Africa's Talking callbacks. |
| `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | Phone calls through LiveKit instead. |
| `CALL_AGENT_NAME` | Name of the phone-call agent. Default `tapnod-caller`. |
| `DEMO_PHONE` | Number the POS rings for Amaka when none is typed, e.g. `08031234567`. |
| `DEMO_AUTO_LINK` | What happens when an unknown card is tapped: `demo` charges Amaka (default), `latest` charges the newest sign-up, a customer id charges that customer, empty shows "Card not linked". |

## Deploy

The whole app (landing page, customer app, POS and API) runs as one container.

**Docker**

```bash
docker build -t tapnod .
docker run -p 8080:8080 tapnod
```

**Kubernetes.** Every push to `main` that changes the server builds the image and publishes it to `ghcr.io/tech-sis123/team-gateway:latest` (see `.github/workflows/server-image.yml`). The manifest in `k8s/app.yaml` creates a Deployment and a Service, both named `app`. The container listens on port 8080, the Service exposes port 80, and the health check is `/healthz`.

```bash
export KUBECONFIG=path/to/your-kubeconfig.yaml
kubectl apply -f k8s/app.yaml
kubectl rollout status deployment/app
```

After a new push: `kubectl rollout restart deployment/app`. Logs: `kubectl logs deploy/app -f`.

## API

Customer requests use the header `Authorization: Bearer <token>`.

| Method and path | Purpose |
| --- | --- |
| `GET /healthz` | Health check |
| `POST /api/auth/signup` | Create an account: name, 10-digit account number, phone, PIN or password, language |
| `POST /api/auth/login` | Sign in with account number and PIN or password |
| `POST /api/auth/passkey/login/options`, `POST /api/auth/passkey/login` | Sign in with a fingerprint |
| `POST /api/demo/session` | Sign in as the demo customer |
| `GET /api/me` | The signed-in customer |
| `POST /api/me/passkey/options`, `POST /api/me/passkey` | Add a fingerprint |
| `GET /api/me/latest` | The newest payment request for this customer |
| `POST /api/me/prefs` | Save language and voice |
| `POST /api/me/subscribe` | Turn on notifications for this phone |
| `POST /api/customer/requests/{id}/approve/options`, `.../approve` | Approve with a fingerprint signature or a PIN |
| `POST /api/customer/requests/{id}/decline` | Decline |
| `GET /api/pos/customers` | List customers (name, Tapnod ID, masked account number) |
| `POST /api/pos/requests` | Start a payment from a `card_token` or a `customer_id` |
| `GET /api/pos/requests/{id}` | Status: `pending`, `approved`, `declined`, `expired` or `cancelled` |
| `POST /api/pos/requests/{id}/cancel` | The shop cancels while waiting |
| `POST /api/pos/cards/link` | Link a card token to a customer |
| `POST /api/pos/requests/{id}/call` | Ring the customer for approval (optional `phone`) |
| `POST /api/tw/voice`, `/api/tw/status` | Twilio call script (TwiML) and call progress |
| `POST /api/at/voice` | Africa's Talking voice callback (returns call instructions as XML) |
| `POST /api/voice/requests/{id}` | Used by the phone-call agent: call progress, approve with PIN, decline |

## Project layout

```text
server/
  server.js              Routes: pages, accounts, customer and POS API
  db.js                  Postgres storage, or memory when there is no DATABASE_URL
  auth.js                PIN and password hashing (scrypt), sessions, passkey checks
  push.js                Phone notifications (Web Push)
  tts.js                 Nigerian voices through YarnGPT
  public/landing.html    Landing page
  public/app.html        Customer app (also served at /demo)
  public/pos.html        Laptop POS
  public/i18n.js         English, Pidgin, Yorùbá, Igbo, Hausa
  public/sw.js           Shows notifications when the page is closed
  public/tapnod.css      Shared styles
  calls.js               Starts phone calls through LiveKit
  atcalls.js             Phone calls through Africa's Talking
  twcalls.js             Phone calls through Twilio
caller/
  agent.py               LiveKit agent: rings the customer, reads the payment, takes her PIN
Dockerfile               Container image
k8s/app.yaml             Kubernetes Deployment and Service
.github/workflows/       Builds and publishes the image
```

## What a real launch would change

- **Account numbers** are taken as typed. A bank launch would confirm ownership with a name enquiry, BVN or OTP.
- **Card reading** would come from a certified POS terminal, which would pass Tapnod a token.
- **Storage:** the demo keeps data in memory. Production needs Postgres with backups.
- **Translations:** the Yorùbá, Igbo and Hausa lines need checking by native speakers.
