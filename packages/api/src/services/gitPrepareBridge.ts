import { getEnv, logger } from "@aif/shared";

const log = logger("git-prepare-bridge");

export type GitPrepareProvider = "github" | "gitlab";

export interface GitPrepareBridgeResult {
  ok: boolean;
  gitPreparedAt?: string;
  /** Present when the agent reported a structured prepare failure. */
  errorCode?: string;
  error?: string;
}

function internalApiHeaders(): Record<string, string> {
  const token = getEnv().INTERNAL_BROADCAST_TOKEN?.trim() ?? "";
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
    headers["X-Internal-Broadcast-Token"] = token;
  }
  return headers;
}

/**
 * Ask the agent to auto-prepare the local git repo for a VCS connection
 * (origin, credentials, default branch, AI Factory scaffold). Synchronous.
 *
 * GitHub and GitLab share one endpoint contract (`POST /<provider>/prepare`);
 * only the provider namespace differs.
 *
 * - `strict = true` (Sync now / first sync): failures are surfaced to the caller
 *   so the task can be blocked immediately.
 * - `strict = false` (Connect): failures are logged and returned as a warning;
 *   the connection is still saved — the next Sync now re-runs prepare.
 */
export async function callAgentGitPrepare(
  projectId: string,
  options: { provider: GitPrepareProvider; strict?: boolean; timeoutMs?: number },
): Promise<GitPrepareBridgeResult> {
  const env = getEnv();
  const baseUrl = env.AGENT_INTERNAL_URL.replace(/\/$/, "");
  const url = `${baseUrl}/${options.provider}/prepare`;
  // Prepare runs real git (clone/fetch/checkout/commit of the AI Factory
  // scaffold) and can take well over 30s on first connect — allow up to 2 minutes.
  const timeoutMs = options.timeoutMs ?? 120_000;

  log.info(
    { projectId, provider: options.provider, agentUrl: baseUrl, strict: options.strict ?? false },
    "Requesting agent git-prepare",
  );
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: internalApiHeaders(),
      body: JSON.stringify({ projectId }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const result: GitPrepareBridgeResult = {
      ok: false,
      errorCode: `${options.provider}_prepare_unavailable`,
      error: `Agent internal API unavailable: ${message}`,
    };
    log.warn(
      { projectId, provider: options.provider, err: error },
      "git-prepare agent call failed (unreachable)",
    );
    return result;
  }

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as {
      error?: string;
      code?: string;
      projectId?: string;
    } | null;
    const result: GitPrepareBridgeResult = {
      ok: false,
      errorCode: payload?.code ?? `${options.provider}_prepare_failed`,
      error: payload?.error ?? `Agent git-prepare failed with status ${response.status}`,
    };
    log.warn(
      { projectId, provider: options.provider, status: response.status, code: result.errorCode },
      "git-prepare failed",
    );
    return result;
  }

  const payload = (await response.json().catch(() => null)) as {
    ok?: boolean;
    gitPreparedAt?: string;
  } | null;
  const result: GitPrepareBridgeResult = {
    ok: payload?.ok !== false,
    gitPreparedAt: payload?.gitPreparedAt,
  };
  log.info(
    { projectId, provider: options.provider, gitPreparedAt: result.gitPreparedAt },
    "git-prepare completed",
  );
  return result;
}

export interface SubmoduleSyncBridgeResult {
  ok: boolean;
  submodulesInitialized?: boolean;
  error?: string;
}

/**
 * Ask the agent to sync submodules for an already-prepared project
 * (best-effort, non-blocking). Called on every Sync now, not just on
 * first prepare, so projects connected before the submodule-init feature
 * was deployed also get their submodules populated.
 *
 * Failure is logged but the bridge always returns a result — the caller
 * must continue the import workflow regardless.
 */
export async function callAgentSubmoduleSync(
  projectId: string,
  options: { timeoutMs?: number } = {},
): Promise<SubmoduleSyncBridgeResult> {
  const env = getEnv();
  const baseUrl = env.AGENT_INTERNAL_URL.replace(/\/$/, "");
  const url = `${baseUrl}/submodules/sync`;
  const timeoutMs = options.timeoutMs ?? 60_000;

  log.debug({ projectId }, "Requesting agent submodule sync");
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: internalApiHeaders(),
      body: JSON.stringify({ projectId }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as {
        error?: string;
      } | null;
      log.warn(
        { projectId, status: response.status, error: payload?.error ?? "unknown" },
        "Submodule sync agent call failed",
      );
      return { ok: false, submodulesInitialized: false, error: payload?.error };
    }
    const payload = (await response.json().catch(() => null)) as SubmoduleSyncBridgeResult | null;
    return {
      ok: payload?.ok !== false,
      submodulesInitialized: payload?.submodulesInitialized ?? false,
      error: payload?.error,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn({ projectId, err: message }, "Submodule sync agent call unavailable (non-blocking)");
    return { ok: false, submodulesInitialized: false, error: message };
  }
}
