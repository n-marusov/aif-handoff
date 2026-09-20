# GitLab MCP Server Reference

> Source: https://docs.gitlab.com/user/model_context_protocol/mcp_server/
> Source: https://docs.gitlab.com/user/model_context_protocol/mcp_server_tools/
> Created: 2026-09-20
> Updated: 2026-09-20

This is the entry point for the GitLab MCP server reference. Connection setup, authentication, and versioning live here; the tool catalog and full parameter tables live in [tools.md](tools.md).

## Overview

The GitLab Model Context Protocol (MCP) server lets MCP-compatible AI tools (Claude Desktop, Claude Code, Cursor, VS Code Copilot, Gemini CLI, Kiro, OpenAI Codex, Zed) connect to a GitLab instance and read or act on GitLab data: projects, repository files and commits, branches, merge requests, work items (issues/tasks/epics), CI/CD pipelines and job logs, security vulnerabilities, and search.

- **Tier:** Free, Premium, Ultimate
- **Offering:** GitLab.com, GitLab Self-Managed, GitLab Dedicated
- **Status:** Beta
- **Feedback:** issue 561564
- **Endpoint:** `https://<gitlab.example.com>/api/v4/mcp`

The server is not a static API: it negotiates the MCP protocol version at `initialize`, authenticates each client through OAuth 2.0 Dynamic Client Registration (DCR), and can narrow or widen its tool surface per client via HTTP headers (toolsets, individual tools, tool-name prefix).

> Related local reference: `gitlab-rest-api.md` (REST API v4 — auth, pagination, endpoints). The MCP server is a separate surface that wraps GitLab internals; MCP tool names and parameters do **not** map 1:1 to REST endpoints.

## Core Concepts

**MCP server endpoint** — a single HTTP path per instance: `https://<gitlab.example.com>/api/v4/mcp`. On GitLab.com use `gitlab.com` as the host. On Self-Managed/Dedicated use your instance URL.

**Transport** — the server supports two:
- **HTTP transport (recommended)** — direct connection, no extra dependencies. Introduced in GitLab 18.6; tool prefixing added in 18.11.
- **stdio transport with `mcp-remote`** — connection through a proxy; requires Node.js 20+.

**OAuth 2.0 Dynamic Client Registration (DCR)** — on first connect a client:
1. Registers itself as an OAuth application on the instance.
2. Requests authorization to access your GitLab data.
3. Receives an access token for secure API access.

DCR-created applications are per client. A pre-registered shared OAuth application can replace DCR (see [Authentication](#authentication-reusing-a-single-oauth-application)).

**Toolsets** — named groups of tools (`meta`, `core`, `merge_requests`, `work_items`, `repository`, `ci`, plus opt-in `duo_agent_platform`, `wikis`, `code_security`). Selected per client with an HTTP header. Feature-flagged (GitLab 19.5, `mcp_toolsets`, disabled by default).

**Tool-name prefix** — an optional per-client prefix so several GitLab servers (or several MCP servers) do not collide on tool names.

**Protocol version negotiation** — the client proposes a version in `initialize`; the server answers with a supported version or a JSON-RPC error listing supported versions.

## Prerequisites

Allow access to the MCP server before connecting:
- On **GitLab.com**: for the top-level group.
- On **GitLab Self-Managed** and **GitLab Dedicated**: for the instance.

## Transports and Client Configuration

### HTTP transport (recommended)

Generic `mcpServers` JSON (used by most clients):

```json
{
  "mcpServers": {
    "GitLab": {
      "type": "http",
      "url": "https://<gitlab.example.com>/api/v4/mcp"
    }
  }
}
```

Replace `<gitlab.example.com>` with the instance URL, or `gitlab.com` on GitLab.com.

### Tool-name prefixing (HTTP)

Add the `X-Gitlab-Mcp-Server-Tool-Name-Prefix` header. The prefix is truncated to the first 32 characters if longer.

```json
{
  "mcpServers": {
    "GitLab": {
      "type": "http",
      "url": "https://<gitlab.example.com>/api/v4/mcp",
      "headers": {
        "X-Gitlab-Mcp-Server-Tool-Name-Prefix": "gitlab_"
      }
    }
  }
}
```

### stdio transport with `mcp-remote`

Prerequisite: Node.js version 20 or later.

```json
{
  "mcpServers": {
    "GitLab": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://<gitlab.example.com>/api/v4/mcp"
      ]
    }
  }
}
```

If `npx` is installed locally rather than globally, provide the full path to `npx` in `command`.

### Client-specific setup

| Client | Transport | Where to configure | Auth step |
| --- | --- | --- | --- |
| Cursor | HTTP | Settings > Cursor Settings > Tools & MCP > New MCP Server (edits `mcp.json`) | Browser OAuth prompt on save; restart Cursor if it does not appear |
| Claude Code | HTTP | `claude mcp add --transport http GitLab https://<gitlab.example.com>/api/v4/mcp` | Type `/mcp`, select the GitLab server, approve in browser; re-run `/mcp` to verify |
| Claude Desktop | stdio (`mcp-remote`) | `claude_desktop_config.json` (Settings > Developer > Edit Config; macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`) | Browser OAuth on first connect; verify under Settings > Developer and Settings > Connectors |
| Gemini Code Assist / Gemini CLI | HTTP | `~/.gemini/settings.json`, key `httpUrl` | Run `/mcp auth GitLab`, approve in browser |
| GitHub Copilot in VS Code | HTTP | Command Palette > `MCP: Add Server` > HTTP > URL > server ID `GitLab`; save globally or in `vscode/mcp.json` | Browser OAuth; check status with `MCP: List Servers` |
| Kiro IDE / CLI | HTTP | `~/.kiro/settings/mcp.json` | Browser OAuth; else run `/mcp` in Kiro CLI |
| OpenAI Codex | HTTP | `codex mcp add GitLab --url "https://<gitlab.example.com>/api/v4/mcp"`, then `~/.codex/config.toml` | `codex mcp login GitLab`, approve in browser |
| Zed | stdio (`mcp-remote`) | `agent: open settings` > Model Context Protocol (MCP) Servers > Add Server | Browser OAuth; toggle the GitLab server off/on if it does not appear |

Prerequisites for Claude Desktop and Zed: Node.js 20+ available globally in `PATH` (verify with `which -a node`).

**Gemini** uses a different key name:

```json
{
  "mcpServers": {
    "GitLab": {
      "httpUrl": "https://<gitlab.example.com>/api/v4/mcp"
    }
  }
}
```

**OpenAI Codex** requires the `rmcp_client` feature flag in `~/.codex/config.toml`:

```toml
[features]
"rmcp_client" = true

[mcp_servers.GitLab]
url = "https://<gitlab.example.com>/api/v4/mcp"
```

**Zed** uses the `mcp-remote` proxy:

```json
{
  "GitLab": {
    "command": "npx",
    "args": ["-y", "mcp-remote@latest", "https://<gitlab.example.com>/api/v4/mcp"],
    "env": {}
  }
}
```

**Claude Desktop** uses `mcp-remote` with `-y`:

```json
{
  "mcpServers": {
    "GitLab": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://<gitlab.example.com>/api/v4/mcp"]
    }
  }
}
```

## Toolsets

Availability is controlled by the `mcp_toolsets` feature flag (GitLab 19.5, disabled by default). When enabled, limit the tools the server returns with the `X-Gitlab-Enabled-Mcp-Server-Toolsets` HTTP header (comma-separated names).

| Toolset | Included by default |
| --- | --- |
| `meta` | Always |
| `core` | Yes |
| `merge_requests` | Yes |
| `work_items` | Yes |
| `repository` | Yes |
| `ci` | Yes |
| `duo_agent_platform` | No (opt-in) |
| `wikis` | No (opt-in) |
| `code_security` | No (opt-in) |

```json
{
  "mcpServers": {
    "GitLab": {
      "type": "http",
      "url": "https://<gitlab.example.com>/api/v4/mcp",
      "headers": {
        "X-Gitlab-Enabled-Mcp-Server-Toolsets": "core,work_items"
      }
    }
  }
}
```

Rules:
- To include an opt-in toolset, name it explicitly. To request every toolset including opt-in ones, set the header to `all`.
- Toolset names are matched case-insensitively (`ci`, `CI`, `Ci` all work).
- An unrecognized toolset name returns a `400` error.
- Omit both the toolsets header and the tools header to get the default toolsets.
- Omit the toolsets header but set `X-Gitlab-Enabled-Mcp-Server-Tools` (individual tool names) to get **only** the named tools — no default toolsets and no `meta` tools.
- Setting both headers returns the **union** of both lists, never the intersection, so it never returns fewer tools than either header alone.

## Supported MCP Protocol Versions

The server negotiates the version in the `initialize` request. An unsupported request returns a JSON-RPC error listing supported versions.

| Protocol version | Support |
| --- | --- |
| `2025-11-25` | Supported. The server also answers with this version when a client asks for a newer version. |
| `2025-06-18` | Supported. |
| `2025-03-26` | Supported. |
| `2026-07-28` | Accepted in the `initialize` request only. The server answers with `2025-11-25` because it does not implement the stateless features of this version yet (see issue 627825). |

GitLab keeps supporting a protocol version after the MCP specification deprecates it. Removing a version is a breaking change and is announced on the deprecations and removals page first.

## Authentication: Reusing a Single OAuth Application

When an MCP client connects, it uses OAuth 2.0 DCR to create a new OAuth application on your instance. Whether you must reuse a pre-registered OAuth application depends on the instance:

- On instances where an administrator turns off DCR, you **must** reuse a pre-registered OAuth application, because MCP clients cannot register automatically.
- On all other instances, reuse is optional. Reuse one to avoid:
  - On Self-Managed and Dedicated, many users or repeatedly connecting clients creating a large number of OAuth applications on the instance.
  - The DCR rate limit of **10 registrations per hour per IP**. Users sharing an egress IP (corporate network or VPN) can exceed it and fail to authenticate.

Every user still authorizes with OAuth and receives their own access token. A shared application is the OAuth client identity, not a shared credential.

**Scopes for a shared application:**

| Scope | Reused by |
| --- | --- |
| Instance | All users on the instance |
| Group | Members of a group |
| User | A user's own account |

**Prerequisites:**
- An MCP client that supports pre-configured OAuth credentials and the `clientId` field in its configuration.
- Administrator access to create an instance-scoped application.
- The Owner role for the group to create a group-scoped application.

**Steps:**
1. Create an OAuth application for an instance, group, or user.
2. For scopes, select **mcp** and clear the **Confidential** checkbox.
3. Save the application.
4. Configure the MCP client with the application ID. The application ID is the `clientId`. The configuration key varies by client but is typically `clientId` or `client_id` in the OAuth configuration of the GitLab MCP server, usually in an `mcp.json` file.

For instance and user applications you can also create the application with the REST API. No REST API exists for group-owned applications, so use the group UI.

OAuth application creation through the Admin UI, and through the group and user UI, was introduced in GitLab 19.3.

### Security considerations

- The redirect URI registered on the OAuth application must **exactly match** the redirect URI the MCP client sends during the OAuth flow. A single shared application cannot serve MCP clients with different redirect URIs — create a separate shared application per client type.
- Users authenticating with the client ID must still complete OAuth authorization with their own GitLab credentials and can access only the data they are permitted to.
- GitLab does not verify which MCP client presents the `clientId`. Any other MCP client that supports pre-registration could use the same `clientId`. The `clientId` controls which OAuth application is used, not which client software is allowed.
- Pre-registered applications created with the REST API do not enforce Proof Key for Code Exchange (PKCE). PKCE defends against authorization code interception for public clients.
- To enforce PKCE, verify that your MCP client sends `code_challenge` and `code_challenge_method` during the OAuth flow. GitLab accepts PKCE parameters for pre-registered applications but does not require them.

## Best Practices

1. **Prefer HTTP transport.** It is the recommended transport, needs no Node.js proxy, and is the only one that supports tool-name prefixing and toolset headers.
2. **Guard against prompt injection.** The GitLab docs repeat this warning for every client: you are responsible for guarding against prompt injection when you use these tools. Exercise extreme caution, or use MCP tools only on GitLab objects you trust. Treat file contents, issue bodies, MR descriptions, and CI logs as untrusted input.
3. **Prefix tool names when more than one GitLab server is configured.** Use `X-Gitlab-Mcp-Server-Tool-Name-Prefix` (truncated to 32 characters) to avoid collisions with other MCP servers or other GitLab instances.
4. **Narrow the tool surface with toolsets** when a client only needs one domain (`core,work_items`), to reduce prompt surface and confusion. Remember the feature flag gates this.
5. **Reuse a single OAuth application on shared instances** to avoid OAuth application sprawl and the 10-per-hour-per-IP DCR rate limit.
6. **Resolve usernames to numeric IDs with `get_user`** before setting assignees or reviewers.
7. **Pass the head SHA guard on merge and approve.** `accept_merge_request` requires `sha`, and `save_merge_request_review` accepts `sha` for `approve` — use the `diff_head_sha` returned by `get_merge_request` so a merge or approval is refused if the head moved.
8. **Use cursor pagination as documented per tool.** Tools are inconsistent: some use `after`/`first` with `pageInfo.endCursor`/`endCursor`, others use `page`/`per_page`. Do not assume one scheme.
9. **Follow version history before relying on a tool.** Most tools are GitLab 19.x-era; older instances will not expose them.
10. **Set `first` explicitly with `list_commits` + `with_stats`** because the documented default conflicts (table says 20, prose says 10 with a hard cap of 10).

## Common Pitfalls

- **Assuming REST parameter names.** MCP tools use their own names, and they are internally inconsistent: some take `id`, others `project_id`, others `url`. `list_branches` takes `id`, while `list_repository_tree` and `list_tags` take `url`/`project_id`. Check the parameter table per tool in [tools.md](tools.md).
- **Expecting `diffs` from `get_merge_request`.** The `diffs` facet returns change statistics only. Use `get_merge_request_diffs` for patch text.
- **Reading binary or LFS files.** `get_repository_file` is text only and errors on binary files, Git LFS files, and files a project excludes from GitLab Duo context.
- **Large partial edits with `add_commit`.** Partial edits (`old_str`/`new_str`) are unsupported for files larger than 10 MiB, for binary files, and for LFS files. They also replace exactly one occurrence — ambiguous matches need more context.
- **Repeating an `old_str`.** If the text occurs more than once, the partial edit fails; add surrounding context.
- **Writing note bodies that start a line with `/`.** `save_note` and `save_merge_request_review` reject lines starting with `/` to avoid triggering quick actions such as `/merge`.
- **Combining create-only and update-only work item fields.** `labels`/`label_ids` are create-only; on update use `add_labels`/`remove_labels` (or the `_ids` variants). Likewise `state`, `todo_action`, `clear_weight` are update-only.
- **`create_issue` vs `save_work_item`.** `create_issue` silently creates unknown labels and drops unknown milestone titles; `save_work_item` errors on names it cannot resolve. Prefer `save_work_item`.
- **Deleting via `manage_pipeline`.** If only `pipeline_id` is set, `manage_pipeline` deletes the pipeline and all related data. To update metadata, also pass `name`.
- **Pagination mismatches in group listings.** `list_projects` with `group_id` cannot combine subgroup traversal with `min_access_level` or `visibility`; adding either narrows the listing to that group only. Check `subgroupsIncluded` in the response.
- **`get_pipeline` `bridge_jobs` null values.** A bridge job's `downstream_pipeline` is `null` both when no downstream pipeline exists yet and when you lack access — the two cases are indistinguishable.
- **Answering the wrong Duo session state.** `send_duo_session_input` works only for `input_required` sessions whose last CI job finished. Sessions in `plan_approval_required` or `tool_call_approval_required` cannot be answered over MCP yet.
- **Ignoring toolset feature-flag state.** Toolset selection (`mcp_toolsets`, 19.5) is disabled by default; on instances where it is off, the toolset headers have no effect.
- **Unrecognized toolset names.** They return a `400` error rather than being ignored.
- **Assuming toolset headers intersect.** If you set both `X-Gitlab-Enabled-Mcp-Server-Toolsets` and `X-Gitlab-Enabled-Mcp-Server-Tools`, the result is the **union**, so you cannot use the tools header to subtract from the toolsets header.
- **Stale cross-references in the docs.** Some Duo tool descriptions reference tools that are not documented on the tools page (`trigger_duo_flow`, `ask_duo_agent`). Do not assume those tools are callable.

## Version Notes

### Server history

| Version | Change |
| --- | --- |
| 18.3 | Introduced as an experiment with feature flags `mcp_server` and `oauth_dynamic_client_registration`, disabled by default. |
| 18.6 | Changed from experiment to beta; feature flags `mcp_server` and `oauth_dynamic_client_registration` removed. HTTP transport introduced. |
| 18.7 | Support for the `2025-03-26`, `2025-06-18`, and `2025-11-25` MCP protocol specifications added. |
| 18.11 | Tool prefixing added for HTTP transport. |
| 19.2 | Changed to a separate setting and moved from GitLab Premium to GitLab Free. |
| 19.5 | Toolset selection added with the `mcp_toolsets` feature flag, disabled by default. |

### Tool renames and aliases

| Old name | New name | Since | Notes |
| --- | --- | --- | --- |
| `gitlab_search` | `search` | 18.8 | Renamed. |
| `create_merge_request` | `save_merge_request` | 19.3 | Old names remain as aliases; also `update_merge_request`. |
| `get_job_log` | `get_job` | 19.3 | `get_job_log` remains as an alias and always returns the `log` facet. |
| `create_branch` | `add_branch` | 19.3 | `create_branch` remains as an alias. |
| `semantic_code_search` | `semantic_search` | 19.4 | Old name remains as an alias; `semantic_query` renamed to `q`. |
| `create_merge_request_note`, `create_workitem_note` | `save_note` | 19.4 | Original names continue to work as aliases. |
| `get_duo_workflow_status` | `get_duo_session` | 19.4 | Alias accepted. |
| `create_work_item`, `update_work_item` | `save_work_item` | 19.4 | Aliases. |

### Removed / superseded

- `create_issue`, `get_issue`, `get_workitem_notes` — unlisted in 19.4, still callable while callers migrate. Superseded by `save_work_item`, `get_work_item`, and `get_work_item` with `include: ["notes"]` respectively.
- `manage_pipeline` — `list` action removed in 19.3 (use `list_pipelines`); `create`, `retry`, `cancel` actions removed in 19.3 (use `save_pipeline`).

### Add-on and tier gating

- `semantic_search` requires the GitLab Duo Core, Pro, or Enterprise add-on.
- `link_work_items` with `blocks` or `blocked_by` requires Premium or Ultimate.
- `save_work_item` fields: `weight`/`clear_weight`/`status_id`/`is_fixed` require Premium or Ultimate; `health_status`/`agent_plan`/`readiness_score` and the `list_work_items` `health_status_filter`/`status` filters require Ultimate.
- `save_merge_request_review` with `post_duo_review` requires GitLab Duo Code Review.

## Related Topics

- MCP servers in the AI Catalog (AI Catalog: agents and flows that can be run from MCP via the Duo session tools)
- GitLab REST API v4 — see the local `gitlab-rest-api.md` reference
- Tool catalog and parameter tables — see [tools.md](tools.md)
