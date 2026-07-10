/**
 * Discord interactions relay (issue #32) — the single Interactions Endpoint URL of Eden's
 * shared app. Discord POSTs every interaction here; the control plane verifies the Ed25519
 * signature, answers the endpoint-validation PING itself (no guild is connected at setup time),
 * and otherwise forwards the RAW request (body + signature headers untouched) to the bound
 * agent instance's eve Discord channel, which re-verifies and replies with the interaction
 * token. A dumb pipe: the bot token never leaves the control plane. Resource route (action only).
 */
import { data, type ActionFunctionArgs } from "react-router";

import { getDiscordAppConfig } from "~/discord/config.server";
import { DISCORD_CHANNEL_ROUTE } from "~/discord/connect.server";
import {
  defaultRelayDeps,
  resolveRelayTarget,
  verifyDiscordSignature,
  type InteractionPayload,
} from "~/discord/relay.server";

/** Discord's interaction must be answered within 3s — leave a little slack for our own hop. */
const FORWARD_TIMEOUT_MS = 2800;

export async function action({ request }: ActionFunctionArgs) {
  const config = getDiscordAppConfig();
  if (!config) throw data("discord app not configured", { status: 503 });

  const raw = await request.text();
  const sig = request.headers.get("x-signature-ed25519");
  const ts = request.headers.get("x-signature-timestamp");
  if (!verifyDiscordSignature(raw, sig, ts, config.publicKey)) {
    throw data("invalid signature", { status: 401 });
  }

  let payload: InteractionPayload;
  try {
    payload = JSON.parse(raw) as InteractionPayload;
  } catch {
    throw data("invalid payload", { status: 400 });
  }

  // PING (type 1): Discord's endpoint validation and heartbeat. Answered control-plane-side —
  // at endpoint-setup time no guild is connected yet, and it needs a signed PONG to accept the URL.
  if (payload.type === 1) {
    return data({ type: 1 });
  }

  const target = await resolveRelayTarget(payload, defaultRelayDeps());
  if (!target.ok) {
    return target.reason === "no-connection"
      ? data("no agent connected for this interaction", { status: 404 })
      : data("the connected agent has no live deployment", { status: 503 });
  }

  // Forward the raw request unchanged — the instance re-verifies the signature over this exact
  // body, so the headers pass through verbatim. Discord's deadline is 3s.
  try {
    const res = await fetch(`${target.url}${DISCORD_CHANNEL_ROUTE}`, {
      method: "POST",
      headers: {
        "content-type":
          request.headers.get("content-type") ?? "application/json",
        "x-signature-ed25519": sig!,
        "x-signature-timestamp": ts!,
      },
      body: raw,
      signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
    });
    const body = await res.text();
    return new Response(body, {
      status: res.status,
      headers: {
        "content-type": res.headers.get("content-type") ?? "application/json",
      },
    });
  } catch {
    return data("the connected agent did not respond in time", { status: 504 });
  }
}
