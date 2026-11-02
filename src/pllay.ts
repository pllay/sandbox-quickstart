// Thin fetch wrapper over the PLLAY settlement API (create, lock, settle, poll, receipt, webhooks). This is the whole
// client: no dependencies, Node 18+ global fetch.
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

export type EventState = "open" | "locked" | "held" | "settled" | "reversed" | "voided";

/**
 * Fields the settlement server sets itself. A client value is refused with 422 server_locked_field.
 * They still appear on responses once the server has set them.
 */
export const SERVER_LOCKED_FIELDS = ["threshold", "outcome", "confidence", "model_version"] as const;

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

/** Client body for POST /v1/events. `threshold` is optional only so older callers still typecheck; it is never sent. */
export interface CreateEventInput {
  type: Settlement["type"];
  path: Settlement["path"];
  threshold?: number;
  spec: object;
  stake_ref?: string | null;
  notional_minor?: number;
}

/** Client body for POST /v1/events/{id}/settle. Outcome, confidence, and model_version are not accepted. */
export interface SettleEventInput {
  evidence_uri?: string | null;
  reviewer_id?: string | null;
  evidence?: Record<string, unknown> | null;
}

function withoutServerLockedFields(body: object): Record<string, unknown> {
  const locked = new Set<string>(SERVER_LOCKED_FIELDS);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (locked.has(key) || value === undefined) continue;
    out[key] = value;
  }
  return out;
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
  async createEvent(input: CreateEventInput) {
    const body = withoutServerLockedFields({ notional_minor: 0, ...input });
    return (await this.call<Settlement>("POST", "/v1/events", body, { "Idempotency-Key": randomUUID() })).data;
  }

  async lockEvent(id: string) {
    return (await this.call<Settlement>("POST", `/v1/events/${id}/lock`, {})).data;
  }

  /**
   * Settles an event. Send an empty object. The server sets outcome, confidence, and model_version.
   * A sandbox settle is synthetic (response header X-PLLAY-Synthetic: true). Do not send those fields
   * for a sandbox key or a production key: the server owns them.
   */
  async settleEvent(id: string, body: SettleEventInput = {}) {
    const r = await this.call<Settlement>("POST", `/v1/events/${id}/settle`, withoutServerLockedFields(body));
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
