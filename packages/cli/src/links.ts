/**
 * Where somebody without an account makes one, from the CLI.
 *
 * Offered only against deliverd.dev: a self-hosted server has its own sign-up,
 * or none, and sending its users to ours would be wrong. Tagged with the CLI's
 * campaign and the moment it was offered, so a sign-up from a terminal is
 * counted against the package that sent it (`apps/web/src/lib/package-funnels.test.ts`).
 */
export const HOSTED = "https://deliverd.dev";

export type SignUpMoment = "login" | "not-logged-in";

export function signUpUrl(moment: SignUpMoment): string {
  return `${HOSTED}/sign-up?utm_source=npm&utm_medium=package&utm_campaign=cli&utm_content=${moment}`;
}

/** The line to print, or nothing when the CLI points somewhere else. */
export function signUpLine(baseUrl: string, moment: SignUpMoment): string | null {
  return baseUrl.replace(/\/+$/, "") === HOSTED ? `No account yet? Create a free one: ${signUpUrl(moment)}` : null;
}
