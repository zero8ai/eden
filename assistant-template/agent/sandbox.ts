import { defaultBackend, defineSandbox } from "eve/sandbox";

// The assistant's sandbox is a minimal scratch shell only. The assistant makes REPO changes
// exclusively through its eden_* tools (which stage drafts via Eden's callback API) — never
// through this shell. Its existence also gives the image a sandbox template to prewarm at
// `eve start` (a skills/ directory requires one), which is why it is present but bare.
const names = (process.env.EDEN_SANDBOX_ENV ?? "").split(",").filter(Boolean);
const env = Object.fromEntries(names.map((n) => [n, process.env[n] ?? ""]));

export default defineSandbox({
  backend: () => defaultBackend({ docker: { env }, vercel: { env } }),
});
