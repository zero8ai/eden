// Shared client for Eden's assistant callback API. Every eden_* tool is a
// thin wrapper over this. All variability arrives via env: EDEN_API_URL + EDEN_ASSISTANT_TOKEN
// (injected by Eden's deploy). Never throws — every failure path returns { ok: false, error } so
// the model reads the text, exactly like the delegation relay.

type EdenResult = Record<string, unknown> & { ok?: boolean; error?: string };

export async function edenCall(
  action: string,
  body: Record<string, unknown> = {},
): Promise<EdenResult> {
  const baseUrl = process.env.EDEN_API_URL;
  const token = process.env.EDEN_ASSISTANT_TOKEN;
  if (!baseUrl || !token) {
    return { ok: false, error: "The Eden assistant API is not configured for this instance." };
  }
  try {
    const res = await fetch(baseUrl.replace(/\/+$/, "") + "/api/assistant/" + action, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + token,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180_000),
    });
    const data = (await res.json().catch(() => null)) as EdenResult | null;
    if (!res.ok) {
      return {
        ok: false,
        error:
          data && typeof data.error === "string"
            ? data.error
            : "Eden API error (HTTP " + res.status + ").",
      };
    }
    return data ?? { ok: false, error: "Eden returned an empty response." };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: "Couldn't reach Eden: " + message };
  }
}
