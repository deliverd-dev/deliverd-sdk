import { describe, expect, it } from "vitest";
import { DeliverdError } from "./errors.js";
import { EXPLANATIONS, SIGN_UP_URL } from "./messages.js";

/**
 * Somebody who installed the package and ran it with no key is the one reader
 * guaranteed to need an account. The error tells them where a free one is,
 * tagged so the sign-up is counted against this package.
 */
describe("running without a key", () => {
  it("ends with the free sign-up link, tagged for this package", () => {
    expect(SIGN_UP_URL).toBe(
      "https://deliverd.dev/sign-up?utm_source=npm&utm_medium=package&utm_campaign=sdk&utm_content=no-api-key"
    );
    const error = new DeliverdError(0, "no_api_key", "An apiKey is required.");
    expect(error.hint).toBe(EXPLANATIONS.no_api_key!.hint);
    // Last, so a terminal that turns it into a link takes nothing after it.
    expect(error.hint!.endsWith(` ${SIGN_UP_URL}`)).toBe(true);
    expect(error.hint).toContain('{ mode: "development" }');
  });
});
