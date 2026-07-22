/**
 * Google Drive connection (Eden marketplace, ships WITH the Google Sheets connector).
 *
 * This module exists so the agent can SHARE the spreadsheets it creates. Sharing is a Google Drive
 * operation (`drive.permissions.create`), not a Sheets API call, and the Drive API lives on a
 * different host (`www.googleapis.com`) than Sheets (`sheets.googleapis.com`) — so it is its own
 * eve OpenAPI connection with its own vendored spec. eve turns each operation into a tool
 * (`google_drive__permissions_create`, `google_drive__files_list`, …).
 *
 * Scope: the Google Sheets connector requests `drive.file` alongside `spreadsheets`. `drive.file`
 * grants access ONLY to files this app created (or that the user explicitly opened with it), so in
 * practice these tools act on the sheets the agent made via `google_sheets__spreadsheets_create` —
 * it can share them and manage who has access, but cannot see the rest of the account's Drive.
 * That is the "its own sheets" model: the agent owns and shares exactly what it creates.
 *
 * Auth is identical to the Sheets connection — it exchanges the SAME per-agent Google refresh token
 * (provisioned by Eden at deploy as `GOOGLE_OAUTH_*`) for a short-lived access token. eve caches the
 * token and pre-refreshes from `expiresAt`. Kept as a self-contained `getToken` (mirroring
 * google-sheets.ts / gmail.ts) so each connection module stands alone.
 *
 * Spec placement: the OpenAPI document is vendored as `data/google-drive.openapi.json` (a plain,
 * inert data file — kept OUT of `connections/` so eve only treats the `.ts` module here as a
 * connection) and imported as an inline object.
 */
import { defineOpenAPIConnection } from "eve/connections";

import spec from "../data/google-drive.openapi.json";

const TOKEN_URL = "https://oauth2.googleapis.com/token";

/** Exchange the refresh token for a fresh access token. eve caches + pre-refreshes from expiresAt. */
async function getToken(): Promise<{ token: string; expiresAt: number }> {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_OAUTH_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      "Google Sheets connection is not configured — GOOGLE_OAUTH_CLIENT_ID / " +
        "GOOGLE_OAUTH_CLIENT_SECRET / GOOGLE_OAUTH_REFRESH_TOKEN are injected by Eden at deploy " +
        "from the agent's Google connection. Reconnect Google from the Deployment tab.",
    );
  }
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }).toString(),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Google refused the token refresh (HTTP ${res.status})${body ? `: ${body}` : "."} ` +
        "If this persists, reconnect Google from the agent's Deployment tab.",
    );
  }
  const json = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!json.access_token) throw new Error("Google's refresh response had no access_token.");
  const ttlMs = (json.expires_in ?? 3599) * 1000;
  // Expire 60s early so eve refreshes before Google actually rejects the token.
  return { token: json.access_token, expiresAt: Date.now() + ttlMs - 60_000 };
}

/**
 * Whether the sharing scope was actually granted (issue #165 pattern): `drive.file` is added to the
 * Sheets connector's request, but a grant made before this version — or one narrowed at reconnect —
 * may lack it, in which case the Drive calls would 403. `GOOGLE_OAUTH_SCOPES` (injected at deploy)
 * carries the granted scopes; absent (self-managed env) → assume granted.
 */
function canShare(): boolean {
  const scopes = (process.env.GOOGLE_OAUTH_SCOPES ?? "").split(/\s+/).filter(Boolean);
  if (scopes.length === 0) return true;
  return (
    scopes.includes("https://www.googleapis.com/auth/drive.file") ||
    scopes.includes("https://www.googleapis.com/auth/drive")
  );
}

export default defineOpenAPIConnection({
  spec: spec as unknown as Record<string, unknown>,
  description:
    "Google Drive v3 (sharing subset) — share and manage access to the spreadsheets THIS agent " +
    "created. Use google_drive__permissions_create to share a sheet (body: role reader/commenter/" +
    "writer + type user/group/domain/anyone; emailAddress for a person; sendNotificationEmail to " +
    "email them a link), google_drive__permissions_list to see who has access, and " +
    "google_drive__permissions_delete to revoke it. google_drive__files_list / _files_get find a " +
    "sheet's id and webViewLink (shareable URL). The fileId of a sheet is its spreadsheetId. " +
    "Scope is drive.file: these tools only reach files the agent created — not the rest of the " +
    "account's Drive. " +
    (canShare()
      ? ""
      : "NOTE: the drive.file permission is not granted on this connection yet, so sharing will " +
        "fail with 403 — reconnect Google from the agent's Deployment tab (leave all requested " +
        "permissions checked) to enable it."),
  auth: { getToken },
});
