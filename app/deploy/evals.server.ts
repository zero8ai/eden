/**
 * Evals-as-deploy-gate scaffold (M5 — PRD §11, §7.3). eve supports TypeScript eval suites; the
 * gate runs them against a Release and blocks the deploy on failure. Executing suites needs the
 * build/sandbox host (same toolchain as deploy), so this is the seam + hook: the controller can
 * call `runEvalGate` before promoting a Release. Until a runner is configured it reports
 * `skipped` (non-blocking), so deploys aren't gated on infrastructure that isn't there yet.
 */
export interface EvalGateResult {
  passed: boolean;
  skipped: boolean;
  detail: string;
  scores?: { name: string; score: number }[];
}

/**
 * Run the project's eval suite against a Release. Placeholder: wire to `eve eval` on the build
 * host (M5). Returns `skipped` when no runner is configured — callers treat skipped as pass.
 */
export async function runEvalGate(
  _projectId: string,
  _releaseId: string,
): Promise<EvalGateResult> {
  if (!process.env.EDEN_EVAL_RUNNER) {
    return {
      passed: true,
      skipped: true,
      detail: "No eval runner configured (EDEN_EVAL_RUNNER); gate skipped.",
    };
  }
  // M5: invoke the runner on the build host, collect scored results, decide pass/fail.
  return { passed: true, skipped: false, detail: "eval runner not yet implemented" };
}
