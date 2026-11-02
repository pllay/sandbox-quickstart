import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, mock, test } from "node:test";
import { PllayClient, SERVER_LOCKED_FIELDS } from "../src/pllay.js";
import { certificationBlockedMessage, quickstartChoice } from "../src/quickstart.js";

const EVENT_ID = "00000000-0000-4000-8000-000000000001";

afterEach(() => {
  mock.restoreAll();
});

function stubFetch() {
  const calls: Array<{ method: string; url: string; body: unknown; idempotencyKey: string | null }> = [];
  mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = init?.body;
    const body = typeof raw === "string" ? JSON.parse(raw) as unknown : null;
    const headers = new Headers(init?.headers);
    calls.push({
      method: init?.method ?? "GET",
      url: String(input),
      body,
      idempotencyKey: headers.get("Idempotency-Key"),
    });
    const settling = String(input).endsWith("/settle");
    const event = {
      event_id: EVENT_ID,
      type: "promo",
      path: "vod",
      state: settling ? "settled" : "open",
      spec: { title: "Sandbox quickstart" },
      outcome: settling ? "yes" : null,
      confidence: settling ? 0.97 : null,
      threshold: 0.9,
      model_version: settling ? "pllay-sandbox-synthetic-v1" : null,
      evidence_uri: null,
      settlement_id: settling ? "00000000-0000-4000-8000-000000000002" : null,
      reversal_settlement_id: null,
      reviewer_id: null,
      stake_ref: null,
      notional_minor: 0,
      reason: null,
    };
    const responseHeaders = new Headers({ "content-type": "application/json" });
    if (settling) responseHeaders.set("x-pllay-synthetic", "true");
    const status = init?.method === "POST" && String(input).endsWith("/v1/events") ? 201 : 200;
    return new Response(JSON.stringify(event), { status, headers: responseHeaders });
  });
  return calls;
}

function assertNoLockedFields(body: unknown): void {
  assert.equal(typeof body, "object");
  assert.notEqual(body, null);
  const keys = Object.keys(body as object);
  for (const field of SERVER_LOCKED_FIELDS) {
    assert.equal(keys.includes(field), false, `request body includes locked field ${field}`);
  }
}

test("create and settle request bodies omit server-locked fields", async () => {
  const calls = stubFetch();
  const client = new PllayClient("pllay_sk_sandbox_test", "https://staging.example.test/oracle-settlement");
  const created = await client.createEvent({
    type: "promo",
    path: "vod",
    threshold: 0.8,
    spec: { title: "Sandbox quickstart", question: "Did player A win the recorded match?" },
  });
  await client.settleEvent(created.event_id, {
    outcome: "yes",
    confidence: 0.95,
    model_version: "quickstart-1",
  } as never);

  const create = calls.find((c) => c.method === "POST" && c.url.endsWith("/v1/events"));
  const settle = calls.find((c) => c.method === "POST" && c.url.endsWith("/settle"));
  assert.ok(create);
  assert.ok(settle);
  assert.equal(create.url.startsWith("https://staging.example.test/"), true);
  assert.ok(create.idempotencyKey);
  assertNoLockedFields(create.body);
  assertNoLockedFields(settle.body);
  assert.deepEqual(create.body, {
    notional_minor: 0,
    type: "promo",
    path: "vod",
    spec: { title: "Sandbox quickstart", question: "Did player A win the recorded match?" },
  });
  assert.deepEqual(settle.body, {});
});

test("create sends game_slug for the default auto-settle title", async () => {
  const calls = stubFetch();
  const client = new PllayClient("pllay_sk_sandbox_test", "https://staging.example.test/oracle-settlement");
  const choice = quickstartChoice([], "", "");
  assert.equal(choice.ok, true);
  if (!choice.ok) return;
  await client.createEvent({ type: "promo", path: "vod", spec: choice.spec });
  const create = calls.find((c) => c.method === "POST" && c.url.endsWith("/v1/events"));
  assert.ok(create);
  assertNoLockedFields(create.body);
  assert.deepEqual(create.body, {
    notional_minor: 0,
    type: "promo",
    path: "vod",
    spec: {
      title: "Fortnite",
      question: "Did the POV player win (Victory Royale)?",
      game_slug: "fortnite",
    },
  });
});

test("dota2 create sends pov_side and a flag overrides the env slug", async () => {
  const calls = stubFetch();
  const client = new PllayClient("pllay_sk_sandbox_test", "https://staging.example.test/oracle-settlement");
  const choice = quickstartChoice(["--game-slug", "dota2", "--pov-side", "away"], "fortnite", "");
  assert.equal(choice.ok, true);
  if (!choice.ok) return;
  await client.createEvent({ type: "promo", path: "vod", spec: choice.spec });
  const create = calls.find((c) => c.method === "POST" && c.url.endsWith("/v1/events"));
  assert.ok(create);
  const spec = (create.body as { spec: { game_slug?: string; pov_side?: string } }).spec;
  assert.equal(spec.game_slug, "dota2");
  assert.equal(spec.pov_side, "away");
  assertNoLockedFields(create.body);
});

test("certification_blocked message names the slug", () => {
  const message = certificationBlockedMessage("sandbox-quickstart", "evt-1");
  assert.match(message, /game_slug "sandbox-quickstart"/);
  assert.match(message, /not a title offered for auto-settlement/);
  assert.match(message, /evt-1 stays locked/);
  assert.match(message, /not settled/);
});

test("quickstart source and README do not send locked settle fields", () => {
  const index = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  assert.doesNotMatch(index, /threshold\s*:/);
  assert.doesNotMatch(index, /outcome\s*:\s*["']/);
  assert.doesNotMatch(index, /confidence\s*:\s*[0-9]/);
  assert.doesNotMatch(index, /model_version\s*:\s*["']/);
  assert.doesNotMatch(readme, /production key must send/i);
  assert.doesNotMatch(readme, /send your own `outcome`/i);
  assert.match(readme, /do not send `outcome`, `confidence`, or `model_version`/);
  assert.match(readme, /offered for auto-settlement/);
  assert.match(readme, /"game_slug":"fortnite"/);
});
