import type { HttpClient } from "./http.js";
import { listOrCollect, type PageOf } from "./paging.js";
import type {
  CreatedWebhookEndpoint,
  CreateWebhookEndpointInput,
  ListWebhookEndpointsInput,
  TestWebhookEndpointInput,
  UpdateWebhookEndpointInput,
  WebhookEndpoint,
  WebhookTestResult,
} from "./types.js";

/**
 * The organisation's webhook endpoints: where its events are sent.
 *
 * ```ts
 * const endpoint = await deliverd.webhookEndpoints.create({
 *   url: "https://hooks.example.com/deliverd",
 *   events: ["approval.approved", "approval.rejected"],
 * });
 * saveSecret(endpoint.secret); // returned this once, never again
 * ```
 *
 * **Needs an administrator's key with `webhooks:manage`.** An endpoint
 * receives every event in the organisation, so the API checks the key's
 * holder is an owner or an administrator on every call, and refuses an agent
 * key outright (`agent_not_permitted`) — reads included.
 *
 * Distinct from `deliverd.webhooks`, which verifies what arrives at an
 * endpoint and makes no request at all.
 */
export class WebhookEndpoints {
  constructor(private readonly http: HttpClient) {}

  /**
   * Newest first. With no `limit` this is every endpoint; with a `limit` it is
   * one page of that size, and `listPage` hands back the cursor to continue from.
   */
  async list(input: ListWebhookEndpointsInput = {}, signal?: AbortSignal): Promise<WebhookEndpoint[]> {
    return listOrCollect(input, (q) => this.listPage({ ...input, ...q }, signal));
  }

  /** One page, and the cursor to continue from — null when it is the end. */
  async listPage(
    input: ListWebhookEndpointsInput = {},
    signal?: AbortSignal
  ): Promise<PageOf<WebhookEndpoint>> {
    const { webhookEndpoints, nextCursor } = await this.http.request<{
      webhookEndpoints: WebhookEndpoint[];
      nextCursor: string | null;
    }>({
      method: "GET",
      path: "/webhook-endpoints",
      query: { limit: input.limit, cursor: input.cursor },
      signal,
    });
    return { items: webhookEndpoints, nextCursor };
  }

  /**
   * Add an endpoint. The result carries `secret`, **the only time it is
   * returned**: keep it with whatever receives the events. A retried call
   * replays this same response, secret included, rather than adding a second
   * endpoint.
   */
  create(input: CreateWebhookEndpointInput, signal?: AbortSignal): Promise<CreatedWebhookEndpoint> {
    return this.http.request({ method: "POST", path: "/webhook-endpoints", body: input, signal });
  }

  /** One endpoint, with its delivery health. Never its secret. */
  get(id: string, signal?: AbortSignal): Promise<WebhookEndpoint> {
    return this.http.request({
      method: "GET",
      path: `/webhook-endpoints/${encodeURIComponent(id)}`,
      signal,
    });
  }

  /**
   * Change the address, events, description or format, or turn it off and on.
   * Only what you send changes. Turning one back on clears its run of failures.
   */
  update(id: string, input: UpdateWebhookEndpointInput, signal?: AbortSignal): Promise<WebhookEndpoint> {
    return this.http.request({
      method: "PATCH",
      path: `/webhook-endpoints/${encodeURIComponent(id)}`,
      body: input,
      signal,
    });
  }

  /** Remove it, and its delivery log. `update(id, { enabled: false })` pauses it instead. */
  delete(id: string, signal?: AbortSignal): Promise<void> {
    return this.http.request({
      method: "DELETE",
      path: `/webhook-endpoints/${encodeURIComponent(id)}`,
      signal,
    });
  }

  /**
   * Send it one event now — `"test": true`, obviously fake ids — and get back
   * what it answered. Never retried, and never counted toward switching the
   * endpoint off. `delivered: false` is an answer about the endpoint; this
   * throws only when the call itself is refused.
   */
  test(id: string, input: TestWebhookEndpointInput = {}, signal?: AbortSignal): Promise<WebhookTestResult> {
    return this.http.request({
      method: "POST",
      path: `/webhook-endpoints/${encodeURIComponent(id)}/test`,
      body: input,
      signal,
    });
  }
}
