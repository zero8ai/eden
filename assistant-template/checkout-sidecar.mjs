// Assistant checkout sidecar (docs/ASSISTANT.md — coding-agent model).
//
// A tiny HTTP listener the assistant INSTANCE runs alongside `eve start`, on a second port
// (AUX_PORT, default 3100), loopback-bound. It owns the per-conversation git checkouts on the
// shared home volume (/workspace/home/checkouts/<conversationId>) that both the instance and the
// model's bash sandbox see. The control plane drives it:
//
//   POST /ensure {conversationId}          → clone/fetch + checkout eden/conv-<id>; report base moves
//   GET  /tree?conversationId=<id>         → full working-tree snapshot vs the merge-base with base
//
// GitHub credentials NEVER live here at rest: on each clone/fetch the sidecar asks the control
// plane (EDEN_API_URL + EDEN_ASSISTANT_TOKEN, both instance-only env) for a short-lived token
// NARROWED to this one repo with contents:read, and passes it to git via a per-invocation
// http.extraheader — never the remote URL, never git config on the shared volume. The edna token
// and the read token stay in this instance process; they are never exposed in any response (the
// sandbox can reach this port over the network but can only read tree state, which is its own work).
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { mkdir, stat, readFile, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const exec = promisify(execFile);

const AUX_PORT = Number(process.env.EDEN_AUX_PORT ?? 3100);
const API_URL = (process.env.EDEN_API_URL ?? "").replace(/\/+$/, "");
const TOKEN = process.env.EDEN_ASSISTANT_TOKEN ?? "";
const CHECKOUT_ROOT = process.env.EDEN_CHECKOUT_ROOT ?? "/workspace/home/checkouts";
const MAX_FILE_BYTES = Number(process.env.EDEN_SYNC_MAX_BYTES ?? 1024 * 1024);

const checkoutDir = (id) => join(CHECKOUT_ROOT, id.replace(/[^A-Za-z0-9_-]/g, ""));
const convBranch = (id) => `eden/conv-${id}`;

/** Ask the control plane for the narrowed read token + repo coordinates for this instance. */
async function repoCreds() {
  if (!API_URL || !TOKEN) throw new Error("checkout sidecar: EDEN_API_URL / EDEN_ASSISTANT_TOKEN unset");
  const res = await fetch(`${API_URL}/api/assistant/read-token`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(20_000),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body || body.ok === false || !body.token) {
    throw new Error(`read-token failed (${res.status}): ${body?.error ?? "no token"}`);
  }
  return {
    token: body.token,
    owner: body.owner,
    repo: body.repo,
    defaultBranch: body.defaultBranch ?? "main",
    cloneUrl: `https://github.com/${body.owner}/${body.repo}.git`,
  };
}

/** git with a per-invocation Authorization header (token never persisted to the volume). */
function authHeaderArgs(token) {
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return ["-c", `http.extraheader=AUTHORIZATION: basic ${basic}`];
}

async function git(dir, args, token) {
  const auth = token ? authHeaderArgs(token) : [];
  const { stdout } = await exec("git", ["-C", dir, ...auth, ...args], {
    maxBuffer: 64 * 1024 * 1024,
    timeout: 120_000,
  });
  return stdout;
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Ensure the conversation checkout exists on its branch; fetch base; report if base advanced. */
async function ensure(conversationId) {
  const creds = await repoCreds();
  const dir = checkoutDir(conversationId);
  const branch = convBranch(conversationId);
  const base = creds.defaultBranch;
  await mkdir(CHECKOUT_ROOT, { recursive: true });

  const auth = authHeaderArgs(creds.token);
  if (!(await exists(join(dir, ".git")))) {
    // Fresh (or recovered after volume/instance loss): shallow-clone and check out the branch,
    // creating it from the remote copy if it exists, else from the base branch.
    await rm(dir, { recursive: true, force: true });
    await exec("git", [...auth, "clone", "--depth", "50", "--no-single-branch", creds.cloneUrl, dir], {
      maxBuffer: 64 * 1024 * 1024,
      timeout: 300_000,
    });
    const remoteHasBranch = await hasRemoteBranch(dir, branch, creds.token);
    if (remoteHasBranch) {
      await git(dir, ["fetch", "--depth", "50", "origin", branch], creds.token);
      await git(dir, ["checkout", "-B", branch, `origin/${branch}`]);
    } else {
      await git(dir, ["checkout", "-B", branch, `origin/${base}`]);
    }
  } else {
    // Existing checkout: refresh origin so we can see whether the base branch advanced.
    await git(dir, ["fetch", "--depth", "50", "origin", base], creds.token);
  }

  const baseTip = (await git(dir, ["rev-parse", `origin/${base}`])).trim();
  const mergeBase = (await git(dir, ["merge-base", "HEAD", `origin/${base}`]).catch(() => baseTip)).trim();
  let advanced = 0;
  try {
    advanced = Number((await git(dir, ["rev-list", "--count", `${mergeBase}..${baseTip}`])).trim()) || 0;
  } catch {
    advanced = 0;
  }
  return { checkoutPath: dir, branch, baseBranch: base, baseTip, mergeBase, advanced };
}

async function hasRemoteBranch(dir, branch, token) {
  try {
    const out = await git(dir, ["ls-remote", "--heads", "origin", branch], token);
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Full snapshot of the checkout vs the merge-base with the base branch — committed AND uncommitted
 * (including untracked). Computed with a THROWAWAY index (GIT_INDEX_FILE) so the model's own index
 * is never mutated: stage the entire working tree into the temp index, then diff it against the
 * merge-base. Binary files and files over the size cap are reported with a flag but no body.
 */
async function tree(conversationId) {
  const creds = await repoCreds().catch(() => null);
  const base = creds?.defaultBranch ?? "main";
  const dir = checkoutDir(conversationId);
  const branch = convBranch(conversationId);
  if (!(await exists(join(dir, ".git")))) {
    return { branch, baseSha: "", dirty: [], missing: true };
  }
  const mergeBase = (
    await git(dir, ["merge-base", "HEAD", `origin/${base}`]).catch(async () =>
      (await git(dir, ["rev-parse", "HEAD"])).trim(),
    )
  ).trim();

  const tmpIndex = join(tmpdir(), `eden-idx-${randomBytes(6).toString("hex")}`);
  const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
  try {
    await exec("git", ["-C", dir, "add", "-A"], { env, timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
    const { stdout } = await exec(
      "git",
      ["-C", dir, "diff", "--cached", "--name-status", "-z", "--no-renames", mergeBase],
      { env, timeout: 120_000, maxBuffer: 64 * 1024 * 1024 },
    );
    const dirty = await parseNameStatus(stdout, dir);
    return { branch, baseSha: mergeBase, dirty };
  } finally {
    await rm(tmpIndex, { force: true }).catch(() => {});
  }
}

/** Parse `git diff --name-status -z` (status\0path\0…) and attach bodies for adds/mods. */
async function parseNameStatus(z, dir) {
  const parts = z.split("\0").filter((p) => p.length > 0);
  const out = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const code = parts[i][0];
    const path = parts[i + 1];
    if (code === "D") {
      out.push({ path, status: "deleted" });
      continue;
    }
    const status = code === "A" ? "added" : "modified";
    const abs = join(dir, path);
    let info = { path, status };
    try {
      const st = await stat(abs);
      if (st.size > MAX_FILE_BYTES) {
        info.oversize = true;
      } else {
        const buf = await readFile(abs);
        if (buf.includes(0)) info.binary = true;
        else info.content = buf.toString("utf8");
      }
    } catch {
      // File vanished between diff and read — treat as no body.
      info.oversize = true;
    }
    out.push(info);
  }
  return out;
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(payload);
}

const server = createServer((req, res) => {
  void (async () => {
    try {
      const url = new URL(req.url, "http://127.0.0.1");
      if (req.method === "POST" && url.pathname === "/ensure") {
        const body = await readBody(req);
        const conversationId = body?.conversationId;
        if (!conversationId) return sendJson(res, 400, { ok: false, error: "conversationId required" });
        return sendJson(res, 200, { ok: true, ...(await ensure(conversationId)) });
      }
      if (req.method === "GET" && url.pathname === "/tree") {
        const conversationId = url.searchParams.get("conversationId");
        if (!conversationId) return sendJson(res, 400, { ok: false, error: "conversationId required" });
        return sendJson(res, 200, { ok: true, ...(await tree(conversationId)) });
      }
      if (url.pathname === "/health") return sendJson(res, 200, { ok: true });
      sendJson(res, 404, { ok: false, error: "not found" });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error?.message ?? String(error) });
    }
  })();
});

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
}

server.listen(AUX_PORT, "0.0.0.0", () => {
  console.log(`[assistant] checkout sidecar listening on :${AUX_PORT}`);
});
