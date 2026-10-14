// PLLAY sandbox quickstart: create an event, lock it, settle it, poll until settled, print the result and receipt link.
//
//   PLLAY_API_KEY=pllay_sk_sandbox_...  PLLAY_API_BASE=<staging API base URL>  npm start
//   npm start -- --webhook      # also run a local receiver that verifies PLLAY's webhook signature (see README)
//
// The key is read from the environment only and never printed.
import { createServer, type Server } from "node:http";
import { PllayApiError, PllayClient, type Settlement, verifyWebhookSignature } from "./pllay.js";

const DEFAULT_BASE = "https://api.pllay.io";
const RECEIPT_BASE = "https://pllay.io/receipt";

const env = (k: string) => (process.env[k] ?? "").trim();
const args = new Set(process.argv.slice(2));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Delivery = { event: string; verified: boolean; body: unknown };

function startReceiver(port: number, getSecret: () => string, onDelivery: (d: Delivery) => void): Promise<Server> {
  const server = createServer((req, res) => {
    if (req.method !== "POST") { res.writeHead(405).end(); return; }
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      const verified = verifyWebhookSignature(raw, req.headers["x-webhook-signature"] as string | undefined, getSecret());
      if (!verified) {
        res.writeHead(401).end("bad signature");
        onDelivery({ event: String(req.headers["x-webhook-event"] ?? "?"), verified: false, body: null });
        return;
      }
      res.writeHead(200).end("ok");
      let body: unknown = null;
      try { body = JSON.parse(raw.toString("utf8")); } catch { /* signed but not JSON: keep null */ }
      onDelivery({ event: String(req.headers["x-webhook-event"] ?? "?"), verified: true, body });
    });
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

async function pollUntilSettled(client: PllayClient, id: string, timeoutMs = 60_000): Promise<Settlement> {
  const deadline = Date.now() + timeoutMs;
  let delay = 500;
  for (;;) {
    const ev = await client.getEvent(id);
    if (ev.state === "settled" || ev.state === "held" || ev.state === "voided" || ev.state === "reversed") return ev;
    if (Date.now() > deadline) throw new Error(`event ${id} still ${ev.state} after ${timeoutMs / 1000}s`);
    await sleep(delay);
    delay = Math.min(delay * 2, 5_000);
  }
}

async function main(): Promise<number> {
  const apiKey = env("PLLAY_API_KEY");
  const base = env("PLLAY_API_BASE") || DEFAULT_BASE;
  if (!apiKey) {
    console.error("Set PLLAY_API_KEY (a pllay_sk_sandbox_ key for the sandbox). It is never printed.");
    return 2;
  }
  const client = new PllayClient(apiKey, base);
  if (client.isSandboxKey && base === DEFAULT_BASE) {
    console.error(`note: sandbox keys only work against the STAGING function URL. Set PLLAY_API_BASE (see README); ${DEFAULT_BASE} will refuse them.`);
  }

  // Optional webhook receiver.
  let server: Server | null = null;
  let registered: { partnerId: string; id: string } | null = null;
  let secret = env("PLLAY_WEBHOOK_SECRET");
  const deliveries: Delivery[] = [];
  if (args.has("--webhook")) {
    const port = Number(env("PORT") || 8787);
    server = await startReceiver(port, () => secret, (d) => {
      deliveries.push(d);
      console.log(`webhook ${d.event}: signature ${d.verified ? "verified" : "REJECTED"}`);
    });
    console.log(`webhook receiver listening on http://localhost:${port}`);
    const publicUrl = env("PLLAY_WEBHOOK_URL");
    const partnerId = env("PLLAY_PARTNER_ID");
    if (publicUrl && partnerId) {
      const wh = await client.createWebhook(partnerId, "event.settled", publicUrl);
      secret = wh.secret;
      registered = { partnerId, id: wh.id };
      console.log(`registered event.settled webhook ${wh.id} -> ${publicUrl} (removed again on exit)`);
    } else if (!secret) {
      console.error("--webhook: set PLLAY_WEBHOOK_URL + PLLAY_PARTNER_ID to register one now, or PLLAY_WEBHOOK_SECRET for one you registered already.");
    }
  }

  try {
    const created = await client.createEvent({
      type: "promo",
      path: "vod",
      threshold: 0.8,
      spec: { title: "Sandbox quickstart", question: "Did player A win the recorded match?" },
    });
    console.log(`created event ${created.event_id} (${created.state})`);
    await client.lockEvent(created.event_id);
    console.log("locked");

    // Sandbox: an empty body asks PLLAY for a deterministic synthetic outcome. A production key must send
    // { outcome, confidence, model_version }.
    const settleBody = client.isSandboxKey ? {} : { outcome: "yes", confidence: 0.95, model_version: "quickstart-1" };
    const { synthetic } = await client.settleEvent(created.event_id, settleBody);
    console.log(`settle requested${synthetic ? " (synthetic sandbox outcome)" : ""}`);

    const ev = await pollUntilSettled(client, created.event_id);
    const receipt = await client.getReceipt(created.event_id).catch(() => null);

    if (server) {
      const until = Date.now() + 10_000;
      while (!deliveries.some((d) => d.event === "event.settled") && Date.now() < until) await sleep(250);
    }

    console.log("\nresult:");
    console.log(JSON.stringify({
      event_id: ev.event_id, state: ev.state, outcome: ev.outcome, confidence: ev.confidence, model_version: ev.model_version,
      settlement_id: ev.settlement_id, evidence_uri: ev.evidence_uri, synthetic,
      receipt_hash: (receipt as { receipts?: Array<{ receipt_hash?: string }> } | null)?.receipts?.[0]?.receipt_hash ?? null,
      webhook: server ? (deliveries.find((d) => d.event === "event.settled")?.verified ?? "not received") : "not requested",
    }, null, 2));
    console.log(`\nreceipt: ${RECEIPT_BASE}/${ev.event_id}`);
    return ev.state === "settled" ? 0 : 1;
  } catch (e) {
    if (e instanceof PllayApiError) {
      console.error(`PLLAY API error ${e.message}`);
      if (e.code === "sandbox_keys_disabled") console.error("This deployment does not accept sandbox keys: point PLLAY_API_BASE at staging.");
    } else {
      console.error(e instanceof Error ? e.message : String(e));
    }
    return 1;
  } finally {
    if (registered) await client.deleteWebhook(registered.partnerId, registered.id).catch(() => undefined);
    server?.close();
  }
}

main().then((code) => process.exit(code));
