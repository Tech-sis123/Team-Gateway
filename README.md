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
- **Laptop POS.** Keypad, card scan through the webcam, USB card reader support, or pick a customer by name. The POS stays silent, so only the customer hears the amount.
- **Nigerian voices** through YarnGPT when an API key is set. Otherwise the phone's own voice is used.

## Demo (laptop + Android phone)

1. **Laptop:** open https://team08.xtradot.co/pos.
2. **Phone:** open https://team08.xtradot.co/demo in Chrome. It signs in straight away as the demo customer, Amaka Okafor (account `0123456789`, PIN `1234`). Tap the screen once to turn on the voice. The first time, it also saves her fingerprint.
3. **Laptop:** type an amount, press **Charge**, then **Scan card** (hold any card up to the webcam) or **Card tapped**.
4. **Phone:** reads the payment aloud and the fingerprint prompt opens. Touch the sensor.
5. **Laptop:** shows **Payment approved** with the receipt. The phone goes back to waiting on its own.

Tips: keep Chrome open on the phone with the volume up, and put both devices on the same reliable network (a phone hotspot works well).

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
Dockerfile               Container image
k8s/app.yaml             Kubernetes Deployment and Service
.github/workflows/       Builds and publishes the image
```

## What a real launch would change

- **Account numbers** are taken as typed. A bank launch would confirm ownership with a name enquiry, BVN or OTP.
- **Card reading** would come from a certified POS terminal, which would pass Tapnod a token.
- **Storage:** the demo keeps data in memory. Production needs Postgres with backups.
- **Translations:** the Yorùbá, Igbo and Hausa lines need checking by native speakers.
