"use client";

/**
 * `<DeliverdDecision>`: a decision session in a React page.
 *
 * A thin wrapper over Deliverd Elements (`@deliverd/sdk/elements`): it loads
 * the script once, mounts the frame into a `<div>` it renders, passes your
 * handlers through, and unmounts the frame when the component goes away or
 * the secret changes. The frame is still served from Deliverd's origin, so
 * your page cannot read it or press its buttons, and the approver still
 * proves who they are before deciding.
 *
 * ```tsx
 * import { DeliverdDecision } from "@deliverd/sdk/react";
 *
 * <DeliverdDecision
 *   clientSecret={clientSecret} // from your server
 *   onDecided={(event) => confirmOnServer(event.sessionId)}
 * />
 *
 * // No account yet? See it with sample data, nothing recorded:
 * <DeliverdDecision demo onDecided={(event) => console.log(event)} />
 * ```
 *
 * React 18 or later. Written without JSX so the package needs no build step
 * of its own for it; `react` is an optional peer dependency, needed only if
 * you import this entry.
 */

import { createElement, useEffect, useRef, type CSSProperties, type ReactElement } from "react";
import {
  loadElements,
  mountWhenLoaded,
  type DecisionEvent,
  type MountDecisionOptions,
  type MountedDecision,
} from "./elements.js";

export type { DecisionEvent } from "./elements.js";

export interface DeliverdDecisionProps
  extends Pick<
    MountDecisionOptions,
    "clientSecret" | "demo" | "title" | "minHeight" | "autoResize" | "onReady" | "onVerified" | "onDecided" | "onExpired"
  > {
  /** Another Deliverd origin, such as a self-hosted deployment. https://deliverd.dev when omitted. */
  origin?: string;
  /** Called when the script cannot load or the options are refused. Thrown to the console otherwise. */
  onError?: (error: Error) => void;
  className?: string;
  style?: CSSProperties;
  id?: string;
}

export function DeliverdDecision(props: DeliverdDecisionProps): ReactElement {
  const host = useRef<HTMLDivElement>(null);
  // Handlers read through a ref, so a new arrow function on every render does not remount the frame.
  const latest = useRef(props);
  latest.current = props;

  const { clientSecret, demo, title, minHeight, autoResize, origin } = props;

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let cancelled = false;
    let mounted: MountedDecision | null = null;
    const relay = (name: "onReady" | "onVerified" | "onDecided" | "onExpired") => (event: DecisionEvent) =>
      latest.current[name]?.(event);

    mountWhenLoaded(
      el,
      {
        clientSecret,
        demo,
        title,
        minHeight,
        autoResize,
        onReady: relay("onReady"),
        onVerified: relay("onVerified"),
        onDecided: relay("onDecided"),
        onExpired: relay("onExpired"),
      },
      () => loadElements({ origin }),
      () => cancelled
    )
      .then((result) => {
        if (cancelled) result?.unmount();
        else mounted = result;
      })
      .catch((err: unknown) => {
        const error = err instanceof Error ? err : new Error(String(err));
        if (latest.current.onError) latest.current.onError(error);
        else console.error(error);
      });

    return () => {
      cancelled = true;
      mounted?.unmount();
    };
  }, [clientSecret, demo, title, minHeight, autoResize, origin]);

  return createElement("div", { ref: host, className: props.className, style: props.style, id: props.id });
}
