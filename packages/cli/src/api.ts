import type { CliConfig } from "./config.js";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown
  ) {
    super(message);
  }
}

export async function api<T>(
  config: CliConfig,
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const response = await fetch(`${config.baseUrl}/api/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${config.token}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ApiError(response.status, "invalid_response", text.slice(0, 200));
  }

  if (!response.ok) {
    const err = (json as { error?: { code?: string; message?: string; details?: unknown } }).error;
    throw new ApiError(
      response.status,
      err?.code ?? "error",
      err?.message ?? `Request failed (${response.status})`,
      err?.details
    );
  }
  return json as T;
}

/**
 * The same request, returned as text.
 *
 * One endpoint answers with something that is not JSON: an evidence pack
 * asked for as `?format=csv`, which is a file a person hands to an auditor.
 * Putting it through `api()` would fail on `JSON.parse` for a response that
 * is exactly what was asked for.
 */
export async function apiText(
  config: CliConfig,
  method: string,
  path: string
): Promise<string> {
  const response = await fetch(`${config.baseUrl}/api/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${config.token}` },
  });
  const text = await response.text();
  if (!response.ok) {
    let code = "error";
    let message = `Request failed (${response.status})`;
    try {
      const err = (JSON.parse(text) as { error?: { code?: string; message?: string } }).error;
      code = err?.code ?? code;
      message = err?.message ?? message;
    } catch {
      message = text.slice(0, 200) || message;
    }
    throw new ApiError(response.status, code, message);
  }
  return text;
}
