import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `deliverd login` is browser-assisted, so a build server cannot use it. The
 * environment is the only way CI can authenticate, and getting the precedence
 * wrong publishes to the wrong place rather than failing — a cached home
 * directory on a shared runner is exactly where a stale config lives.
 */

const ORIGINAL = { ...process.env };

async function load() {
  vi.resetModules();
  return import("./config");
}

beforeEach(() => {
  delete process.env.DELIVERD_TOKEN;
  delete process.env.DELIVERD_URL;
});

afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.restoreAllMocks();
});

describe("credentials from the environment", () => {
  it("uses both variables when both are set", async () => {
    process.env.DELIVERD_TOKEN = "dlv_ci";
    process.env.DELIVERD_URL = "https://app.example.com";
    expect((await load()).loadConfig()).toEqual({
      baseUrl: "https://app.example.com",
      token: "dlv_ci",
    });
  });

  it("trims a trailing slash so paths do not double up", async () => {
    // `${baseUrl}/api/v1/reports` against "https://x/" gives a double slash,
    // which some proxies redirect and some reject.
    process.env.DELIVERD_TOKEN = "dlv_ci";
    process.env.DELIVERD_URL = "https://app.example.com//";
    expect((await load()).loadConfig()?.baseUrl).toBe("https://app.example.com");
  });

  it("stops rather than guessing a URL for a token that has one", async () => {
    // Falling through to the config file here would publish a build server's
    // report to whatever host someone last logged into on that machine.
    process.env.DELIVERD_TOKEN = "dlv_ci";
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => {
        throw new Error("exit");
      }) as never);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const { loadConfig } = await load();
    expect(() => loadConfig()).toThrow("exit");
    expect(exit).toHaveBeenCalledWith(1);
    // And it says which variable is missing, rather than "not logged in".
    expect(String(error.mock.calls[0]?.[0])).toContain("DELIVERD_URL");
  });

  it("ignores a lone URL, which is not a credential", async () => {
    process.env.DELIVERD_URL = "https://app.example.com";
    // Falls through to the config file, which does not exist here.
    expect((await load()).loadConfig()).toBeNull();
  });
});
