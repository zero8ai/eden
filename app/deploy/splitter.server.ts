/**
 * Weighted, session-sticky traffic splitter (D9/D10 — PRD §7.7, ARCH §3.6).
 *
 * The minimal real implementation of the multi-version primitive: one HTTP proxy that fronts
 * every environment at `/e/:environmentId/*`, picks a live deployment by trafficWeight on a
 * session's FIRST request, pins the session to it with a cookie, and proxies. A conversation
 * therefore never flips Release mid-life; weights only steer NEW sessions — exactly the
 * semantics the PRD promises ("weighted, session-sticky").
 *
 * OSS/dev ingress. The managed substrate replaces this with Caddy/Traefik + wake-proxy behind
 * the same deployments/trafficWeight data (the splitter reads the same rows the UI writes).
 */
import http from "node:http";

import { and, eq, inArray } from "drizzle-orm";

import { db } from "~/db/client.server";
import { deployments } from "~/db/schema";

const PORT = Number(process.env.EDEN_SPLITTER_PORT ?? 8787);
const COOKIE = "eden_split";

type LiveDeployment = { id: string; url: string; trafficWeight: number };

async function liveDeployments(environmentId: string): Promise<LiveDeployment[]> {
  const rows = await db
    .select({
      id: deployments.id,
      url: deployments.url,
      trafficWeight: deployments.trafficWeight,
    })
    .from(deployments)
    .where(
      and(eq(deployments.environmentId, environmentId), eq(deployments.status, "live")),
    );
  return rows.filter((r): r is LiveDeployment => !!r.url);
}

/** Weighted random pick across live deployments (weights are relative integers). */
function pick(rows: LiveDeployment[]): LiveDeployment | null {
  const total = rows.reduce((s, r) => s + Math.max(0, r.trafficWeight), 0);
  if (total <= 0) return rows[0] ?? null;
  let roll = Math.random() * total;
  for (const r of rows) {
    roll -= Math.max(0, r.trafficWeight);
    if (roll < 0) return r;
  }
  return rows[rows.length - 1] ?? null;
}

function readCookie(req: http.IncomingMessage, env: string): string | null {
  const raw = req.headers.cookie ?? "";
  const m = raw.match(new RegExp(`${COOKIE}_${env.slice(0, 8)}=([^;]+)`));
  return m ? m[1] : null;
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
  const match = req.url?.match(/^\/e\/([0-9a-f-]{36})(\/.*)?$/);
  if (!match) {
    res.writeHead(404).end("Unknown environment. Use /e/<environmentId>/…");
    return;
  }
  const [, environmentId, rest = "/"] = match;

  const live = await liveDeployments(environmentId);
  if (live.length === 0) {
    res.writeHead(503).end("No live deployments in this environment.");
    return;
  }

  // Sticky: reuse the pinned deployment while it is still live; otherwise (first request
  // of a session, or its version was drained/stopped) pick by weight and pin.
  const pinned = readCookie(req, environmentId);
  let target = live.find((d) => d.id === pinned) ?? null;
  if (!target) {
    target = pick(live);
    if (!target) {
      res.writeHead(503).end("No routable deployment.");
      return;
    }
    res.setHeader(
      "set-cookie",
      `${COOKIE}_${environmentId.slice(0, 8)}=${target.id}; Path=/e/${environmentId}; HttpOnly; SameSite=Lax`,
    );
  }

  const upstream = new URL(rest, target.url);
  const proxied = http.request(
    upstream,
    {
      method: req.method,
      headers: { ...req.headers, host: upstream.host, "x-eden-release": target.id },
    },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    },
  );
  proxied.on("error", (err) => {
    if (!res.headersSent) res.writeHead(502);
    res.end(`Upstream error: ${err.message}`);
  });
  req.pipe(proxied);
}

function startSplitter(): { stop: () => void } {
  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (!res.headersSent) res.writeHead(500);
      res.end(`Splitter error: ${err instanceof Error ? err.message : String(err)}`);
    });
  });
  server.listen(PORT, "127.0.0.1", () => {
    console.log(`[splitter] listening on http://127.0.0.1:${PORT}/e/<environmentId>/`);
  });
  server.unref();
  return { stop: () => server.close() };
}

const globalForSplitter = globalThis as unknown as {
  __edenSplitter?: { stop: () => void };
};

/** Start the splitter once per process; safe to call from any server module. */
export function ensureSplitterStarted(): void {
  if (process.env.EDEN_DISABLE_SPLITTER === "1") return;
  globalForSplitter.__edenSplitter ??= startSplitter();
}
