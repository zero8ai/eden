import type { JsonValue, MobileApiError } from "@eden/api-contract";
import { Platform } from "react-native";

import { authClient, edenUrl } from "./auth-client";

type ApiOptions = Omit<RequestInit, "body"> & {
  body?: BodyInit | JsonValue | Record<string, unknown>;
};

export class EdenApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code = "request_failed",
  ) {
    super(message);
    this.name = "EdenApiError";
  }
}

const absoluteUrl = (path: string) =>
  path.startsWith("http://") || path.startsWith("https://")
    ? path
    : `${edenUrl}${path.startsWith("/") ? path : `/${path}`}`;

export async function edenFetch(path: string, options: ApiOptions = {}) {
  const headers = new Headers(options.headers);
  const native = Platform.OS !== "web";
  const cookie = native ? authClient.getCookie() : null;
  if (cookie) headers.set("Cookie", cookie);
  if (native) headers.set("Origin", edenUrl);
  headers.set("Accept", "application/json");

  let body = options.body as BodyInit | undefined;
  if (
    body != null &&
    !(body instanceof FormData) &&
    typeof body !== "string" &&
    !(body instanceof URLSearchParams) &&
    !(body instanceof Blob)
  ) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(body);
  }

  return fetch(absoluteUrl(path), {
    ...options,
    body,
    credentials: native ? "omit" : "include",
    headers,
  });
}

export async function apiJson<T>(
  path: string,
  options: ApiOptions = {},
): Promise<T> {
  const response = await edenFetch(path, options);
  if (response.status === 401) {
    throw new EdenApiError("Please sign in again.", 401, "unauthorized");
  }
  const payload = (await response.json().catch(() => null)) as
    T | MobileApiError | null;
  if (!response.ok) {
    const error = payload as MobileApiError | null;
    throw new EdenApiError(
      error?.message ?? `Eden returned ${response.status}.`,
      response.status,
      error?.error,
    );
  }
  return payload as T;
}

export async function* apiNdjson<T>(
  path: string,
  options: ApiOptions = {},
): AsyncGenerator<T> {
  const response = await edenFetch(path, options);
  if (!response.ok || !response.body) {
    throw new EdenApiError(
      `Eden returned ${response.status}.`,
      response.status,
    );
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) yield JSON.parse(line) as T;
    if (done) break;
  }
  if (buffer.trim()) yield JSON.parse(buffer) as T;
}
