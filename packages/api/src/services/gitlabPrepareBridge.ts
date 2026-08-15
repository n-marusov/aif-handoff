import { getEnv, logger } from "@aif/shared";

const log = logger("gitlab-prepare-bridge");

export interface GitLabPrepareBridgeResult {
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
 * Ask the agent to auto-prepare the local git repo for a GitLab connection
 * (origin, credentials, default branch, AI Factory scaffold). Synchronous.
 *
 * - `strict = true` (Sync now / first sync): failures are surfaced to the caller
 *   so the task can be blocked immediately.
 * - `strict = false` (Connect): failures are logged and returned as a warning;
 *   the connection is still saved — the next Sync now re-runs prepare.
 */
export async function callAgentGitPrepare(
  projectId: string,
  options: { strict?: boolean; timeoutMs?: number } = {},
): Promise<GitLabPrepareBridgeResult> {
  const env = getEnv();
  const baseUrl = env.AGENT_INTERNAL_URL.replace(/\/$/, "");
  const url = `${baseUrl}/gitlab/prepare`;
  // Prepare runs real git (fetch/checkout/commit of the AI Factory scaffold) and
  // can take well over 30s on first connect — allow up to 2 minutes.
  const timeoutMs = options.timeoutMs ?? 120_000;

  log.info(
    { projectId, agentUrl: baseUrl, strict: options.strict ?? false },
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
    const result: GitLabPrepareBridgeResult = {
      ok: false,
      errorCode: "gitlab_prepare_unavailable",
      error: `Agent internal API unavailable: ${message}`,
    };
    log.warn({ projectId, err: error }, "GitLab git-prepare agent call failed (unreachable)");
    return result;
  }

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as {
      error?: string;
      code?: string;
      projectId?: string;
    } | null;
    const result: GitLabPrepareBridgeResult = {
      ok: false,
      errorCode: payload?.code ?? "gitlab_prepare_failed",
      error: payload?.error ?? `Agent git-prepare failed with status ${response.status}`,
    };
    log.warn(
      { projectId, status: response.status, code: result.errorCode },
      "GitLab git-prepare failed",
    );
    return result;
  }

  const payload = (await response.json().catch(() => null)) as {
    ok?: boolean;
    gitPreparedAt?: string;
  } | null;
  const result: GitLabPrepareBridgeResult = {
    ok: payload?.ok !== false,
    gitPreparedAt: payload?.gitPreparedAt,
  };
  log.info({ projectId, gitPreparedAt: result.gitPreparedAt }, "GitLab git-prepare completed");
  return result;
}
