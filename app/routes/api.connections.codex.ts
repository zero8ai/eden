/**
 * Connect an OpenAI Codex ChatGPT subscription via device-code OAuth (issue #28, Phase 1).
 *
 * The Org-settings "Connect OpenAI Codex" dialog drives this resource route with a `useFetcher`:
 *   - `start`  → request a device code; returns the user code + verification URL to show the human.
 *   - `poll`   → poll the device-token endpoint once; `{ pending }` until the user authorizes, then
 *                exchange for tokens, read the account identity, and persist a sealed connection.
 *
 * Every outcome the dialog should render (device-login-disabled, still-pending, upstream failure)
 * is a 200 JSON body with an `error`/`pending` field, not an HTTP error — only auth/permission
 * failures throw. Write-only: tokens are sealed by `createCodexConnection` and never returned.
 */
import { data, redirect, type ActionFunctionArgs } from "react-router";

import { getSessionAuth } from "~/auth/session.server";
import { resolveActiveWorkspace } from "~/auth/workspace.server";
import {
  DeviceLoginDisabledError,
  exchangeDeviceCode,
  extractAccountIdentity,
  pollDeviceToken,
  requestDeviceCode,
} from "~/connections/codex.server";
import { auth as betterAuth } from "~/lib/auth.server";
import { recordAudit } from "~/managed/audit.server";
import { createCodexConnection } from "~/models/provider-connections.server";

async function canManageWorkspace(
  organizationId: string,
  headers: Headers,
): Promise<boolean> {
  const permission = await betterAuth.api.hasPermission({
    headers,
    body: { organizationId, permissions: { organization: ["update"] } },
  });
  return permission.success;
}

export async function action(args: ActionFunctionArgs) {
  const auth = await getSessionAuth(args);
  if (!auth.user) throw redirect("/login");
  const active = await resolveActiveWorkspace(auth);
  const org = active?.org;
  if (!org) return data({ error: "No organization." }, { status: 400 });
  if (!(await canManageWorkspace(org.id, auth.requestHeaders))) {
    throw new Response("Forbidden", { status: 403 });
  }

  const form = await args.request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "start") {
    try {
      const device = await requestDeviceCode();
      return data({
        deviceAuthId: device.deviceAuthId,
        userCode: device.userCode,
        interval: device.interval,
        verificationUrl: device.verificationUrl,
      });
    } catch (error) {
      if (error instanceof DeviceLoginDisabledError) {
        return data({ error: error.message });
      }
      return data({
        error: error instanceof Error ? error.message : "Couldn't start Codex device login.",
      });
    }
  }

  if (intent === "poll") {
    const deviceAuthId = String(form.get("deviceAuthId") ?? "");
    const userCode = String(form.get("userCode") ?? "");
    if (!deviceAuthId || !userCode) {
      return data({ error: "Missing device authorization details — start again." });
    }
    try {
      const result = await pollDeviceToken({ deviceAuthId, userCode });
      if (result === "pending") return data({ pending: true });

      const tokens = await exchangeDeviceCode({
        authorizationCode: result.authorizationCode,
        codeVerifier: result.codeVerifier,
      });
      const identity = extractAccountIdentity({
        idToken: tokens.idToken,
        accessToken: tokens.accessToken,
      });
      await createCodexConnection({
        orgId: org.id,
        label: identity.email ?? "Codex",
        accountEmail: identity.email,
        accountId: identity.accountId,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: new Date(Date.now() + tokens.expiresIn * 1000),
        createdBy: auth.user.id,
      });
      await recordAudit({
        orgId: org.id,
        actorUserId: auth.user.id,
        action: "model_provider_connected",
        target: "codex",
      });
      return data({ done: true });
    } catch (error) {
      return data({
        error: error instanceof Error ? error.message : "Couldn't connect the Codex account.",
      });
    }
  }

  return data({ error: "Unknown action." }, { status: 400 });
}
