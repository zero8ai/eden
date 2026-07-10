import { redirect } from "react-router";

import { decodeKey, open, seal } from "~/seams/oss/secretbox";

const COOKIE_NAME = "eden-google-oauth-callback";
const COOKIE_MAX_AGE_SECONDS = 5 * 60;
const MAX_STAGED_VALUE_LENGTH = 3_500;

export interface GoogleCallbackPayload {
  code: string | null;
  error: string | null;
  state: string | null;
}

interface StagedGoogleCallback {
  payload: GoogleCallbackPayload;
  issuedAt: number;
  expiresAt: number;
}

function callbackKey(): Buffer {
  return decodeKey(process.env.EDEN_SECRETS_KEY);
}

function secureRequest(request: Request): boolean {
  const configured = process.env.BETTER_AUTH_URL?.trim();
  try {
    const url = configured ? new URL(configured) : new URL(request.url);
    return url.protocol === "https:";
  } catch {
    // Staging must still leave the credential-bearing URL when development configuration is bad.
    return new URL(request.url).protocol === "https:";
  }
}

function cookieValue(request: Request, value: string, maxAge: number): string {
  return [
    `${COOKIE_NAME}=${encodeURIComponent(value)}`,
    "Path=/google/callback",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
    ...(maxAge === 0 ? ["Expires=Thu, 01 Jan 1970 00:00:00 GMT"] : []),
    ...(secureRequest(request) ? ["Secure"] : []),
  ].join("; ");
}

function readCookie(request: Request): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== COOKIE_NAME) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

export function isGoogleCallbackStagingRequest(request: Request): boolean {
  const url = new URL(request.url);
  return (
    url.pathname === "/google/callback" &&
    ["code", "state", "error"].some((name) => url.searchParams.has(name))
  );
}

/**
 * Encrypt the provider response into a short-lived HttpOnly cookie and immediately leave the
 * credential-bearing URL. Session/database work happens only on the clean follow-up request.
 */
export function stageGoogleCallback(
  request: Request,
  now = Date.now(),
): Response {
  const url = new URL(request.url);
  const payload: GoogleCallbackPayload = {
    code: url.searchParams.get("code"),
    error: url.searchParams.get("error"),
    state: url.searchParams.get("state"),
  };

  try {
    const staged: StagedGoogleCallback = {
      payload,
      issuedAt: now,
      expiresAt: now + COOKIE_MAX_AGE_SECONDS * 1000,
    };
    const encrypted = seal(callbackKey(), JSON.stringify(staged));
    const value = Buffer.from(JSON.stringify(encrypted)).toString("base64url");
    if (value.length > MAX_STAGED_VALUE_LENGTH) throw new Error("Too large");
    return redirect("/google/callback", {
      headers: {
        "Set-Cookie": cookieValue(request, value, COOKIE_MAX_AGE_SECONDS),
      },
    });
  } catch {
    // Never render an error on the provider URL: even misconfiguration must leave it immediately.
    return redirect("/google/callback?failure=invalid", {
      headers: { "Set-Cookie": clearGoogleCallbackCookie(request) },
    });
  }
}

export function readStagedGoogleCallback(
  request: Request,
  now = Date.now(),
): GoogleCallbackPayload | null {
  const value = readCookie(request);
  if (!value) return null;
  try {
    const sealed = JSON.parse(Buffer.from(value, "base64url").toString()) as {
      authTag: string;
      ciphertext: string;
      iv: string;
    };
    const staged = JSON.parse(
      open(callbackKey(), sealed),
    ) as Partial<StagedGoogleCallback>;
    const parsed = staged.payload as
      Partial<Record<keyof GoogleCallbackPayload, unknown>> | undefined;
    if (
      !parsed ||
      typeof staged.issuedAt !== "number" ||
      typeof staged.expiresAt !== "number" ||
      staged.expiresAt - staged.issuedAt !== COOKIE_MAX_AGE_SECONDS * 1000 ||
      staged.issuedAt > now + 60_000 ||
      staged.expiresAt <= now ||
      ![parsed.code, parsed.error, parsed.state].every(
        (item) => item === null || typeof item === "string",
      )
    ) {
      return null;
    }
    return {
      code: parsed.code as string | null,
      error: parsed.error as string | null,
      state: parsed.state as string | null,
    };
  } catch {
    return null;
  }
}

export function clearGoogleCallbackCookie(request: Request): string {
  return cookieValue(request, "", 0);
}
