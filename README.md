# PLLAY sandbox quickstart (Node + TypeScript)

Submits a recorded match (clip URL + title adapter + market), polls until PLLAY resolves it, then prints the winner and the receipt link. With `--webhook` it also runs a tiny local receiver that verifies PLLAY's webhook signature.

**Sandbox: no cash moves and nothing is billed.** Sandbox jobs never run real Vision: PLLAY simulates the resolution in about 3 seconds (`simulated: true` on create, `model_version: "pllay-fake-vision-sandbox-v1"`). The clip URL is not fetched, so any https URL works. It is never a real outcome.

Developer docs: <https://pllay.io/developers>

## 1. Get a sandbox key

Sandbox keys are issued on PLLAY's staging environment. Request test keys here: <https://calendly.com/shawn-jck/30min>

You receive three things: the key (`pllay_sk_sandbox_<64 hex>`), the staging API base URL, and your partner id. The key is shown once. Never commit it, never log it, and never put it in a browser bundle.

## 2. Point at staging

Sandbox keys only work on the **staging** API. Production (`https://api.pllay.io`, the default here) refuses them with `403 sandbox_keys_disabled`. So set `PLLAY_API_BASE` to the staging URL you were given:

```bash
export PLLAY_API_KEY="pllay_sk_sandbox_…"          # read from the environment only; never printed
export PLLAY_API_BASE="<staging API base URL>"
```

Or copy them into a local `.env` file and load it with your shell; `.env` is git-ignored.

| Variable | Required | Default |
|---|---|---|
| `PLLAY_API_KEY` | yes | none |
| `PLLAY_API_BASE` | for sandbox keys, yes | `https://api.pllay.io` |
| `PLLAY_WEBHOOK_URL`, `PLLAY_PARTNER_ID` | `--webhook` only: register a webhook now (removed on exit) | none |
| `PLLAY_WEBHOOK_SECRET` | `--webhook` only: the secret of a webhook you registered yourself | none |
| `PORT` | `--webhook` only | `8787` |

## 3. Run

Requires Node 18.17 or later.

```bash
npm install
npm start                 # submit -> poll -> result + receipt link
npm start -- --webhook    # also receive and verify event.settled
```

Output ends with something like:

```
created event … (processing, sandbox simulated)

result:
{ "event_id": "…", "state": "settled", "winner": "Sentinels", "confidence": 97,
  "model_version": "pllay-fake-vision-sandbox-v1", "synthetic": true, "webhook": "not requested" }

receipt: https://pllay.io/receipt/<event_id>
```

Supported adapters include `valorant_result.json`, `lol_result.json`, `fortnite_result.json`, `cs2_matchresult.json` and more (an unsupported one returns `422` listing them all). `market.kind` is `team`, `side` or `pov`, with at least two string options.

## Webhooks

PLLAY signs each delivery with the webhook's secret:

```
X-Webhook-Signature: sha256=<hex HMAC-SHA256(secret, raw request body)>
X-Webhook-Event:     event.settled
X-PLLAY-Environment: sandbox
X-PLLAY-Synthetic:   true
```

Verify against the **raw** body before parsing it, using a constant-time compare (`verifyWebhookSignature` in `src/pllay.ts`). The receiver here answers 401 to anything that fails.

PLLAY has to reach the receiver, so `PLLAY_WEBHOOK_URL` must be public, for example a tunnel to `localhost:8787`. `PLLAY_PARTNER_ID` is the partner id you received with your key. Webhooks are delivered during the settle call, so `event.settled` usually arrives before the poll finishes.

## Limits

Per sandbox key: 60 requests per minute (`429 rate_limit_exceeded`) and 1,000 settles per UTC day (`429 sandbox_daily_limit_exceeded`, with `reset_in_seconds`).

## Notes

- The client (`src/pllay.ts`) is a thin `fetch` wrapper with no runtime dependencies. Copy it into your own project if you like.
- `GET /v1/events/{id}` returns the state and resolution. The public receipt page is `https://pllay.io/receipt/{event_id}`. Sandbox receipts are never anchored.

## License

MIT. See [LICENSE](LICENSE).
