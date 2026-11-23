// MCP Events (io.modelcontextprotocol/events, SEP-3415) inside your network.
//
// Deliverd's hosted MCP server is stateless, so it offers events by poll and
// by webhook only. A webhook needs an address Deliverd can reach, which is
// exactly what a network behind a firewall does not have. The runtime closes
// that gap: it polls Deliverd outbound, with its own key, and offers the
// events to agents beside it by all the ways the extension names that need
// no inbound connection:
//
//   events/list    what this runtime relays
//   events/poll    passed through to Deliverd
//   events/stream  push: a long-lived response the runtime writes to as
//                  Deliverd reports each event, with heartbeats
//
// One upstream poller serves every local stream of the same event and
// arguments, so ten agents waiting on the same gate cost one poll.
//
// Off unless DELIVERD_EVENTS=true. With it off, the runtime answers exactly
// as it did before: no capability, and events/* is "not supported here".

export const EVENTS_EXTENSION = "io.modelcontextprotocol/events";
export const DEFAULT_EVENTS = ["gate.decided", "gate.denied", "approval.decided"];
const MIN_POLL_MS = 1_000;
const HEARTBEAT_MS = 30_000;
const MAX_STREAMS = 200;

/** Which events this runtime relays: DELIVERD_EVENTS_NAMES, comma-separated, or the gate and approval ones. */
export function relayedNames(env) {
  const named = (env.DELIVERD_EVENTS_NAMES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return named.length ? named : DEFAULT_EVENTS;
}

export function eventsEnabled(env) {
  return env.DELIVERD_EVENTS === "true";
}

const keyOf = (name, args) => JSON.stringify([name, Object.keys(args ?? {}).sort().map((k) => [k, args[k]])]);

const sleep = (ms, signal) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });

/**
 * The relay: upstream pollers shared by local streams.
 *
 * `api` is the runtime's Deliverd client (server.mjs deliverdApi), so the
 * key, timeout and user agent are the ones every other call uses.
 */
export function eventRelay({ api, env = {}, log = () => {}, minPollMs = MIN_POLL_MS }) {
  const names = relayedNames(env);
  const hubs = new Map();
  let streams = 0;

  function hub(name, args) {
    const key = keyOf(name, args);
    let h = hubs.get(key);
    if (h) return h;
    const controller = new AbortController();
    h = { listeners: new Set(), cursor: null, ready: null, controller, error: null };
    hubs.set(key, h);
    h.ready = (async () => {
      const first = await api("POST", "/events/poll", { name, arguments: args, cursor: null });
      h.cursor = first.cursor;
    })();
    (async () => {
      try {
        await h.ready;
      } catch (error) {
        h.error = error;
        for (const l of h.listeners) l.error(error);
        hubs.delete(key);
        return;
      }
      while (!controller.signal.aborted) {
        let wait = minPollMs;
        try {
          const page = await api("POST", "/events/poll", { name, arguments: args, cursor: h.cursor });
          h.cursor = page.cursor;
          for (const event of page.events ?? []) for (const l of h.listeners) l.event(event, page.cursor);
          for (const l of h.listeners) l.position(page.cursor, page.truncated === true);
          wait = page.hasMore ? 0 : Math.max(minPollMs, Number(page.nextPollMs ?? minPollMs));
        } catch (error) {
          log(`events: could not poll ${name}: ${error.message}`);
          wait = Math.max(minPollMs, 5_000);
        }
        if (wait) await sleep(wait, controller.signal);
      }
    })();
    return h;
  }

  function leave(name, args, listener) {
    const key = keyOf(name, args);
    const h = hubs.get(key);
    if (!h) return;
    h.listeners.delete(listener);
    if (h.listeners.size === 0) {
      h.controller.abort();
      hubs.delete(key);
    }
  }

  return {
    names,
    allowed: (name) => names.includes(name),
    activeStreams: () => streams,
    hubs: () => hubs.size,

    async list() {
      const answer = await api("GET", "/events");
      return (answer.events ?? [])
        .filter((e) => names.includes(e.name))
        .map((e) => ({ ...e, delivery: ["poll", "push"] }));
    },

    poll(params) {
      return api("POST", "/events/poll", {
        name: params.name,
        arguments: params.arguments ?? {},
        cursor: params.cursor ?? null,
        ...(params.maxAgeMs !== undefined ? { maxAgeMs: params.maxAgeMs } : {}),
        ...(params.maxEvents !== undefined ? { maxEvents: params.maxEvents } : {}),
      });
    },

    /**
     * Push one stream: write notifications to `write` until `signal` aborts.
     * A cursor the client brings is caught up on its own first, then the
     * stream joins the shared poller.
     */
    async stream({ name, args = {}, cursor = null, heartbeatMs = HEARTBEAT_MS, subscriptionId, write, signal }) {
      if (streams >= MAX_STREAMS) throw Object.assign(new Error("Too many event streams on this runtime."), { code: -32025 });
      streams++;
      const meta = { "io.modelcontextprotocol/subscriptionId": subscriptionId };
      const notify = (method, params) => write({ jsonrpc: "2.0", method, params: { ...params, _meta: meta } });
      const terminated = (error) =>
        notify("notifications/events/terminated", { error: { code: -32603, message: "Deliverd could not be reached", data: { reason: error.message } } });
      const sent = new Set();
      let live = false;
      let buffered = [];
      let position = cursor;
      let failed = null;
      const deliver = (event, at) => {
        if (sent.has(event.eventId)) return;
        sent.add(event.eventId);
        if (sent.size > 10_000) sent.delete(sent.values().next().value);
        notify("notifications/events/event", { ...event, cursor: at });
      };
      // Joined first and buffered, so nothing the shared poller hears during a catch-up is lost.
      const listener = {
        event: (event, at) => (live ? (deliver(event, at), (position = at)) : buffered.push([event, at])),
        position: (at) => {
          if (live) position = at;
        },
        error: (error) => {
          failed = error;
        },
      };
      const h = hub(name, args);
      h.listeners.add(listener);
      try {
        try {
          await h.ready;
        } catch (error) {
          failed = error;
        }
        if (failed) return terminated(failed);

        let truncated = false;
        const catchUp = [];
        if (cursor) {
          for (;;) {
            const page = await api("POST", "/events/poll", { name, arguments: args, cursor: position });
            truncated = truncated || page.truncated === true;
            position = page.cursor;
            for (const event of page.events ?? []) catchUp.push([event, page.cursor]);
            if (!page.hasMore) break;
          }
        } else {
          position = h.cursor;
        }
        notify("notifications/events/active", { cursor: position, truncated, heartbeatMs });
        for (const [event, at] of catchUp) deliver(event, at);
        for (const [event, at] of buffered) deliver(event, at);
        buffered = [];
        live = true;

        while (!signal.aborted) {
          await sleep(heartbeatMs, signal);
          if (signal.aborted) break;
          if (failed) return terminated(failed);
          notify("notifications/events/heartbeat", { cursor: position });
        }
      } finally {
        leave(name, args, listener);
        streams--;
      }
    },

    stop() {
      for (const h of hubs.values()) h.controller.abort();
      hubs.clear();
    },
  };
}
