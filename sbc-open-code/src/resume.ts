/**
 * Unlike `claude --continue`, `opencode --continue` scopes strictly to the exact cwd
 * (verified empirically: it does not fall back to the globally newest session across
 * other projects) and starts a fresh session instead of erroring when none exists yet
 * for that directory. It can therefore be passed unconditionally, with no need to query
 * `opencode session list` first.
 */
export function opencodeResumeArgs(): Promise<string[]> {
  return Promise.resolve(["--continue"]);
}
