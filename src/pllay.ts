// Thin fetch wrapper over the PLLAY settlement API (submit, poll, webhooks). This is the whole
// client: no dependencies, Node 18+ global fetch.
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

export type EventState = "processing" | "held" | "settled" | "voided" | "reversed";

/** GET /v1/events/{id} (Resolution API v1). */
export interface Settlement {
  event_id: string;
  status: string;
  state: EventState;
  external_market_id: string | null;
  resolution: {
    outcome_option_index: number | null;
    outcome_label: string | null;
    tier: string;
    settleable: boolean;
    confidence: number | null;
    model_version: string | null;
    adapter_version: string | null;
    resolved_at: string | null;
    latency_ms: number | null;
  } | null;
}

export interface EventInput {
  video_url: string;            // https URL of the recorded match clip
  adapter: string;              // title adapter, e.g. "valorant_result.json"
  game_slug?: string;
  market: { kind: "pov" | "side" | "team"; options: string[] };
  external_market_id?: string;
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

  /** Submits a match for resolution. Idempotency-Key is required; a fresh one is generated per call. */
  async createEvent(input: EventInput) {
    return (await this.call<{ event_id: string; status: string; simulated?: boolean }>("POST", "/v1/events", input, { "Idempotency-Key": randomUUID() })).data;
  }

  async getEvent(id: string) {
    return (await this.call<Settlement>("GET", `/v1/events/${id}`)).data;
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
