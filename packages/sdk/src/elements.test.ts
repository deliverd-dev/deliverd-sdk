import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadElements, mountWhenLoaded, type DeliverdElements } from "./elements.js";

/**
 * `@deliverd/sdk/elements` and `@deliverd/sdk/react` load the hosted script
 * rather than copying it, so what is tested here is the loading: once, from
 * the right origin, reusing a tag the page already has, and failing loudly.
 */

type Listener = () => void;

function fakePage() {
  const scripts: { src: string; async: boolean; listeners: Record<string, Listener[]>; addEventListener(t: string, fn: Listener): void }[] = [];
  const win: Record<string, unknown> = {};
  const doc = {
    head: { appendChild: (s: (typeof scripts)[number]) => scripts.push(s) },
    createElement: () => {
      const s = {
        src: "",
        async: false,
        listeners: {} as Record<string, Listener[]>,
        addEventListener(t: string, fn: Listener) {
          (this.listeners[t] ??= []).push(fn);
        },
      };
      return s;
    },
    querySelector: (selector: string) => scripts.find((s) => selector === `script[src="${s.src}"]`) ?? null,
  };
  vi.stubGlobal("window", win);
  vi.stubGlobal("document", doc);
  const api: DeliverdElements = { mountDecision: vi.fn(() => ({ frame: {} as HTMLIFrameElement, unmount: vi.fn() })), elementsVersion: 1 };
  const fire = (type: "load" | "error", start = true) => {
    if (type === "load" && start) win.Deliverd = api;
    for (const s of scripts) for (const fn of s.listeners[type] ?? []) fn();
  };
  return { scripts, win, api, fire };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("loadElements", () => {
  it("refuses on a server, where there is no page", async () => {
    await expect(loadElements()).rejects.toThrow(/browser/);
  });

  it("adds the v1 script from deliverd.dev once, however often it is asked", async () => {
    const page = fakePage();
    const first = loadElements();
    const second = loadElements();
    expect(page.scripts).toHaveLength(1);
    expect(page.scripts[0]!.src).toBe("https://deliverd.dev/elements/v1.js");
    expect(page.scripts[0]!.async).toBe(true);
    page.fire("load");
    expect(await first).toBe(page.api);
    expect(await second).toBe(page.api);
    // Loaded now: answered from the page, no new tag.
    expect(await loadElements()).toBe(page.api);
    expect(page.scripts).toHaveLength(1);
  });

  it("loads from another origin when told to, keeping only its origin", async () => {
    const page = fakePage();
    const loaded = loadElements({ origin: "https://deliverd.acme.example/some/path" });
    expect(page.scripts[0]!.src).toBe("https://deliverd.acme.example/elements/v1.js");
    page.fire("load");
    await loaded;
  });

  it("uses a script the page already loaded", async () => {
    const page = fakePage();
    page.win.Deliverd = page.api;
    expect(await loadElements()).toBe(page.api);
    expect(page.scripts).toHaveLength(0);
  });

  it("fails when the script cannot load, and tries again next time", async () => {
    const page = fakePage();
    const failed = loadElements({ origin: "https://down.example" });
    page.fire("error");
    await expect(failed).rejects.toThrow(/Could not load Deliverd Elements from https:\/\/down\.example/);
    page.scripts.length = 0;
    const retry = loadElements({ origin: "https://down.example" });
    expect(page.scripts).toHaveLength(1);
    page.fire("load");
    await expect(retry).resolves.toBe(page.api);
  });

  it("fails when the script loads but does not start", async () => {
    const page = fakePage();
    const loaded = loadElements({ origin: "https://odd.example" });
    page.fire("load", false);
    await expect(loaded).rejects.toThrow(/did not start/);
  });

});

describe("mountWhenLoaded", () => {
  const api = () => {
    const mounted = { frame: {} as HTMLIFrameElement, unmount: vi.fn() };
    return { mounted, elements: { mountDecision: vi.fn(() => mounted), elementsVersion: 1 } as DeliverdElements };
  };
  const host = {} as Element;

  it("mounts into the host with the options it was given", async () => {
    const { mounted, elements } = api();
    const onDecided = vi.fn();
    const result = await mountWhenLoaded(host, { clientSecret: "ds1.x", onDecided }, async () => elements, () => false);
    expect(result).toBe(mounted);
    expect(elements.mountDecision).toHaveBeenCalledWith(host, { clientSecret: "ds1.x", onDecided });
  });

  it("mounts nothing when the caller went away while the script loaded", async () => {
    const { elements } = api();
    expect(await mountWhenLoaded(host, { demo: true }, async () => elements, () => true)).toBeNull();
    expect(elements.mountDecision).not.toHaveBeenCalled();
  });

  it("asks for a secret or the demo before loading anything", async () => {
    const load = vi.fn();
    await expect(mountWhenLoaded(host, {}, load, () => false)).rejects.toThrow(/clientSecret .* or demo: true/);
    expect(load).not.toHaveBeenCalled();
  });
});

describe("the React entry", () => {
  const source = readFileSync(join(__dirname, "react.ts"), "utf8");

  it("is a client component that loads the hosted script rather than copying it", () => {
    expect(source.startsWith('"use client";')).toBe(true);
    expect(source).toContain("loadElements({ origin })");
    expect(source).not.toMatch(/createElement\("iframe"/);
  });

  it("unmounts the frame on cleanup and keeps handlers out of the effect's dependencies", () => {
    expect(source).toMatch(/return \(\) => \{\s*cancelled = true;\s*mounted\?\.unmount\(\);/);
    const deps = source.match(/\}, \[([^\]]+)\]\);/)?.[1] ?? "";
    expect(deps).not.toMatch(/on[A-Z]/);
    expect(deps).toContain("clientSecret");
  });

  it("keeps react an optional peer, so non-React users install nothing extra", () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, "../package.json"), "utf8"));
    expect(pkg.dependencies?.react).toBeUndefined();
    expect(pkg.peerDependencies.react).toBe(">=18");
    expect(pkg.peerDependenciesMeta.react.optional).toBe(true);
    expect(pkg.exports["./react"].default).toBe("./dist/react.js");
    expect(pkg.exports["./elements"].default).toBe("./dist/elements.js");
  });
});
