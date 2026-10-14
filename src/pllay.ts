// Thin fetch wrapper over the PLLAY settlement API (create, lock, settle, poll, receipt, webhooks). This is the whole
// client: no dependencies, Node 18+ global fetch.
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

export type EventState = "open" | "locked" | "held" | "settled" | "reversed" | "voided";

/** The Settlement shape every event route returns (openapi.yaml components.schemas.Event). */
export interface Settlement {
  event_id: string;
  type: "promo" | "contest" | "duel";
  path: "vod" | "live";
  state: EventState;
  spec: Record<string, unknown>;
  outcome: string | null;
  confidence: number | null;
  threshold: number;
  model_version: string | null;
  evidence_uri: string | null;
  settlement_id: string | null;
  reversal_settlement_id: string | null;
  reviewer_id: string | null;
  stake_ref: string | null;
  notional_minor: number;
  reason: string | null;
}

export class PllayApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly body: unknown) {
    super(`${status} ${code}: ${message}`);
  }
}

export class PllayClient {
  private readonly base: string;

  constructor(private readonly apiKey: string, base: string) {
    if (!apiKey) throw new Error("PLLAY_API_KEY is required");
    this.base = base.replace(/\/+$/, "");
  }

  get isSandboxKey(): boolean {
    return this.apiKey.startsWith("pllay_sk_sandbox_");
  }

  private async call<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ data: T; headers: Headers }> {
    const res = await fetch(this.base + path, {
      method,
      headers: { "X-Partner-Key": this.apiKey, "Content-Type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data: unknown = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) {
      const d = (data ?? {}) as { error?: string | { code?: string; message?: string }; message?: string };
      const code = typeof d.error === "string" ? d.error : d.error?.code ?? "http_error";
      const message = d.message ?? (typeof d.error === "object" ? d.error?.message : undefined) ?? res.statusText;
      throw new PllayApiError(res.status, code, message, data);
    }
    return { data: data as T, headers: res.headers };
  }

  /** Creates an event. Idempotency-Key is required by the API; a fresh one is generated per call. */
  async createEvent(input: { type: Settlement["type"]; path: Settlement["path"]; threshold: number; spec: Record<string, unknown>; notional_minor?: number }) {
    return (await this.call<Settlement>("POST", "/v1/events", { notional_minor: 0, ...input }, { "Idempotency-Key": randomUUID() })).data;
  }

  async lockEvent(id: string) {
    return (await this.call<Settlement>("POST", `/v1/events/${id}/lock`, {})).data;
  }

  /**
   * Settles an event. With a sandbox key the body may be empty: PLLAY then returns a deterministic synthetic outcome
   * (X-PLLAY-Synthetic: true). With a production key outcome, confidence and model_version are required.
   */
  async settleEvent(id: string, body: Record<string, unknown> = {}) {
    const r = await this.call<Settlement>("POST", `/v1/events/${id}/settle`, body);
    return { settlement: r.data, synthetic: r.headers.get("x-pllay-synthetic") === "true" };
  }

  async getEvent(id: string) {
    return (await this.call<Settlement>("GET", `/v1/events/${id}`)).data;
  }

  async getReceipt(id: string) {
    return (await this.call<Record<string, unknown>>("GET", `/v1/events/${id}/receipt`)).data;
  }

  /** Registers a webhook for one event type. The response carries the signing secret (shown once). */
  async createWebhook(partnerId: string, eventType: string, url: string) {
    return (await this.call<{ id: string; secret: string }>("POST", `/v1/partners/${partnerId}/webhooks`, { event_type: eventType, url })).data;
  }

  async deleteWebhook(partnerId: string, webhookId: string) {
    await this.call("DELETE", `/v1/partners/${partnerId}/webhooks/${webhookId}`);
  }
}

/**
 * PLLAY's webhook signature: X-Webhook-Signature = "sha256=" + hex(HMAC-SHA256(secret, raw request body)).
 * Verify against the RAW bytes, before JSON.parse, with a constant-time compare.
 */
export function verifyWebhookSignature(rawBody: string | Buffer, header: string | null | undefined, secret: string): boolean {
  if (!header || !secret) return false;
  const expected = "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(header.trim());
  return a.length === b.length && timingSafeEqual(a, b);
}
