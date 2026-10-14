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

  /** Sets the partner's webhook URL (PATCH /v1/webhooks). Rotates and returns the signing secret, shown once. */
  async setWebhook(url: string) {
    return (await this.call<{ webhook_url: string; webhook_secret: string }>("PATCH", "/v1/webhooks", { webhook_url: url }, { "Idempotency-Key": randomUUID() })).data;
  }
}

/**
 * PLLAY's webhook signature: X-Pllay-Signature = "t=<unix seconds>,v1=<hex HMAC-SHA256(secret, `${t}.${raw body}`)>".
 * Verify against the RAW bytes, before JSON.parse, with a constant-time compare, and reject stale timestamps.
 */
export function verifyWebhookSignature(rawBody: string | Buffer, header: string | null | undefined, secret: string, toleranceSeconds = 300): boolean {
  if (!header || !secret) return false;
  const m = /^t=(\d+),v1=([0-9a-f]+)$/.exec(header.trim());
  if (!m) return false;
  const t = Number(m[1]);
  if (Math.abs(Date.now() / 1000 - t) > toleranceSeconds) return false;
  const expected = createHmac("sha256", secret).update(`${t}.`).update(rawBody).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(m[2]);
  return a.length === b.length && timingSafeEqual(a, b);
}
