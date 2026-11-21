import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Deliverd } from "./index.js";
import { DEVELOPMENT_SIGN_UP_URL, resetDevelopmentHint } from "./dev.js";

describe("development mode's sign-up hint", () => {
  let log: ReturnType<typeof vi.spyOn>;
  const env = { ...process.env };

  beforeEach(() => {
    resetDevelopmentHint();
    delete process.env.CI;
    delete process.env.DELIVERD_DEV_HINT;
    log = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    log.mockRestore();
    process.env = { ...env };
  });

  const hints = () => log.mock.calls.filter((c) => String(c[0]).includes(DEVELOPMENT_SIGN_UP_URL)).length;

  it("prints once per process, after the first simulated approval, tagged for the site", async () => {
    const deliverd = new Deliverd({ mode: "development" });
    await deliverd.approve({ title: "Deploy production" });
    await deliverd.approve({ title: "Deploy again" });
    expect(hints()).toBe(1);
    expect(DEVELOPMENT_SIGN_UP_URL).toMatch(/^https:\/\/deliverd\.dev\/sign-up\?utm_source=devmode&utm_medium=sdk/);
  });

  it("stays quiet in CI, when turned off, or when logging is off", async () => {
    process.env.CI = "true";
    await new Deliverd({ mode: "development" }).approve({ title: "A" });
    resetDevelopmentHint();
    delete process.env.CI;
    process.env.DELIVERD_DEV_HINT = "0";
    await new Deliverd({ mode: "development" }).approve({ title: "B" });
    resetDevelopmentHint();
    delete process.env.DELIVERD_DEV_HINT;
    await new Deliverd({ mode: "development", development: { log: false } }).approve({ title: "C" });
    expect(hints()).toBe(0);
  });
});
