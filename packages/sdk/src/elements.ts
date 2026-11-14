/**
 * Deliverd Elements from a bundler: load the script, mount a decision.
 *
 * `https://deliverd.dev/elements/v1.js` is the element. This module does not
 * reimplement it; it loads it, once, and hands back the same `mountDecision`
 * a `<script>` tag would. Keeping one copy is the point: the frame, the
 * origin checks on its messages and the sizing all live in that script, so a
 * fix there reaches every page without anybody upgrading a package.
 *
 * Browser only. On a server there is no page to put a frame in, so
 * `loadElements()` rejects there rather than pretending.
 *
 * ```ts
 * import { loadElements } from "@deliverd/sdk/elements";
 *
 * const elements = await loadElements();
 * const decision = elements.mountDecision("#decision", {
 *   clientSecret, // from your server: approvals.createSession(id, { mode: "embedded", origin })
 *   onDecided(event) {
 *     // Tell your server, which reads decisionSessions.get(event.sessionId) before acting.
 *   },
 * });
 * // later: decision.unmount();
 * ```
 */

/** Where Elements is served from, unless you say otherwise. */
export const ELEMENTS_ORIGIN = "https://deliverd.dev";

/** The path of the script on that origin. Versioned: v1 keeps working. */
export const ELEMENTS_PATH = "/elements/v1.js";

/** What every event hands your handler. */
export interface DecisionEvent {
  type: "ready" | "verified" | "decided" | "expired";
  sessionId: string;
  approvalId: string;
  /** Set on `decided`: what the approver chose. */
  decision: "approved" | "rejected" | "changes_requested" | null;
  /** Set on `decided`: the request's own status, which other approvers may still be part of. */
  approvalStatus: string | null;
}

export interface MountDecisionOptions {
  /**
   * The session's `clientSecret`, from `approvals.createSession(id, { mode: "embedded", origin })`
   * on your server. Required unless `demo` is set.
   */
  clientSecret?: string;
  /**
   * Show the demo request instead of a real one: sample data, a code shown on
   * screen, and nothing recorded. Needs no account and frames on any site, so
   * you can see the element and its events before writing server code.
   */
  demo?: boolean;
  /** The frame's accessible title. "Decision" when omitted. */
  title?: string;
  /** The frame's height before it reports its own, in pixels. 320 when omitted. */
  minHeight?: number;
  /** Set `false` to size the frame yourself instead of letting it fit its content. */
  autoResize?: boolean;
  onReady?: (event: DecisionEvent) => void;
  onVerified?: (event: DecisionEvent) => void;
  /** The browser's word only: confirm with `decisionSessions.get(id)` from your server before acting. */
  onDecided?: (event: DecisionEvent) => void;
  onExpired?: (event: DecisionEvent) => void;
}

export interface MountedDecision {
  frame: HTMLIFrameElement;
  unmount(): void;
}

/** What the script puts on `window.Deliverd`. */
export interface DeliverdElements {
  mountDecision(target: string | Element, options: MountDecisionOptions): MountedDecision;
  elementsVersion: number;
}

export interface LoadElementsOptions {
  /**
   * Another Deliverd origin, such as your own self-hosted deployment. Must be
   * the origin the session was made on: the frame only talks to the script
   * that came from its own origin.
   */
  origin?: string;
}

type Loaded = Window & { Deliverd?: Partial<DeliverdElements> };

const loading = new Map<string, Promise<DeliverdElements>>();

function ready(w: Loaded): DeliverdElements | null {
  const api = w.Deliverd;
  return api && typeof api.mountDecision === "function" ? (api as DeliverdElements) : null;
}

/**
 * Loads Elements into the page once, and resolves to its API.
 *
 * Safe to call as often as you like: a second call, from anywhere, waits on
 * the same script rather than adding another. If the page already loaded the
 * script with a `<script>` tag, that one is used.
 */
export function loadElements(options: LoadElementsOptions = {}): Promise<DeliverdElements> {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return Promise.reject(new Error("Deliverd Elements runs in a browser. Call loadElements() from client code."));
  }
  const origin = new URL(options.origin ?? ELEMENTS_ORIGIN).origin;
  const w = window as Loaded;
  const existing = ready(w);
  if (existing) return Promise.resolve(existing);

  const cached = loading.get(origin);
  if (cached) return cached;

  const src = origin + ELEMENTS_PATH;
  const promise = new Promise<DeliverdElements>((resolve, reject) => {
    const fail = (message: string) => {
      loading.delete(origin);
      reject(new Error(message));
    };
    const done = () => {
      const api = ready(w);
      if (api) resolve(api);
      else fail(`Deliverd Elements loaded from ${src} but did not start.`);
    };
    let script = document.querySelector<HTMLScriptElement>(`script[src="${src}"]`);
    if (!script) {
      script = document.createElement("script");
      script.src = src;
      script.async = true;
      document.head.appendChild(script);
    }
    script.addEventListener("load", done, { once: true });
    script.addEventListener("error", () => fail(`Could not load Deliverd Elements from ${src}.`), { once: true });
  });
  loading.set(origin, promise);
  return promise;
}

/**
 * Loads Elements and mounts a decision into `host`, unless `cancelled()` says
 * the caller went away first. Resolves to the mounted decision, or `null`
 * when it was cancelled. What the React component does in an effect, kept
 * here so it can be used, and tested, without React.
 */
export async function mountWhenLoaded(
  host: Element,
  options: MountDecisionOptions,
  load: () => Promise<DeliverdElements>,
  cancelled: () => boolean
): Promise<MountedDecision | null> {
  if (!options.demo && !options.clientSecret) {
    throw new Error("Deliverd: pass clientSecret (from an embedded session), or demo: true.");
  }
  const elements = await load();
  if (cancelled()) return null;
  return elements.mountDecision(host, options);
}
