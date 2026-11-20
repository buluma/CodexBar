# CLIProxyAPI local provider prototype

This local CodexBar plugin reads account status and cached Codex and Claude quota observations from CLIProxyAPI's read-only `GET /v0/management/auth-files` endpoint. A pool summary shows available, unavailable and disabled account counts. Each account has its status, request success and failure counts when available, and separate 5-hour and weekly usage bars. A retry time takes precedence over request counts. It does not trigger quota refreshes or change CLIProxyAPI configuration.

## Install

In CodexBar, open **Settings → Plugins → Install…** and select `cliproxyapi.js`.
Set **CLIProxyAPI URL** to the server origin (for a local default setup, `http://127.0.0.1:8317`) and **Management API key** to the management secret configured in CLIProxyAPI. Approve the requested endpoint when CodexBar asks.

The URL field permits HTTPS, or HTTP to loopback only. Do not expose the management API to an untrusted network: this endpoint returns account names, status, and cached usage metadata.

## Scope and limitations

- The Management API's auth-files list contains cached observations; a new account may have no quota data until CLIProxyAPI has observed usage.
- Codex `Primary` and `Secondary` used-percent signals and Claude `Anthropic-Ratelimit-Unified-5h/7d-Utilization` signals appear as account rows. Other providers and quota signal formats are unsupported.
- CodexBar permits eight sections with 24 rows each. One section is used for the pool summary; larger account lists are split across the remaining sections, and rows beyond that host limit are counted as not shown.
- Request counts and account status are CPA's current runtime values. The pool summary covers Codex and Claude accounts; statuses CPA does not identify as active or ready are not counted as available.
- Refresh rereads CPA's cached observations; it does not request fresh upstream quotas. Observations older than one hour are labeled `Cached >1h` when CPA supplies an observation time. For live quota checks, use CPA's management interface.
- Reset time is shown when CPA supplies a recognized absolute reset time, or a reset-after value with an observation timestamp. Reset-after is measured from the observation, not the current refresh.
- The management key is a secure plugin setting and is sent only to the configured CLIProxyAPI endpoint as `X-Management-Key`.

Run the regression checks with `node examples/cliproxyapi.test.cjs` from the CodexBar repository root.
