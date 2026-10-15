import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { signUpLine, signUpUrl } from "./links.js";

/**
 * `login` opens a browser that asks a stranger to sign in, and every command
 * run before `login` says "Not logged in". Both are where somebody without an
 * account finds out they need one, so both offer a free one — against
 * deliverd.dev only, tagged with the moment it was offered.
 */
describe("the free account the CLI offers", () => {
  it("is ours, tagged with the CLI's campaign and the moment", () => {
    expect(signUpUrl("login")).toBe(
      "https://deliverd.dev/sign-up?utm_source=npm&utm_medium=package&utm_campaign=cli&utm_content=login"
    );
    expect(signUpLine("https://deliverd.dev/", "not-logged-in")).toBe(
      "No account yet? Create a free one: https://deliverd.dev/sign-up?utm_source=npm&utm_medium=package&utm_campaign=cli&utm_content=not-logged-in"
    );
  });

  it("is not offered against a self-hosted server", () => {
    expect(signUpLine("https://deliverd.example.com", "login")).toBeNull();
  });

  it("is printed by login and by the not-logged-in refusal", () => {
    const index = readFileSync(join(__dirname, "index.ts"), "utf8");
    const login = index.slice(index.indexOf('.command("login")'), index.indexOf("openBrowser(authorizeUrl)"));
    expect(login).toContain('signUpLine(baseUrl, "login")');
    const config = readFileSync(join(__dirname, "config.ts"), "utf8");
    const refusal = config.slice(config.indexOf("export function requireConfig"));
    expect(refusal).toMatch(/signUpLine\(process\.env\.DELIVERD_URL \?\? HOSTED, "not-logged-in"\)/);
  });
});
