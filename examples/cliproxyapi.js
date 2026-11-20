defineProvider({
  id: "cliproxyapi",
  name: "CLIProxyAPI",
  icon: { monogram: "CPA", tint: "#5B8DEF" },
  endpoints: [{ setting: "BASE_URL", policy: "https-or-loopback-http" }],
  settings: [
    { key: "BASE_URL", title: "CLIProxyAPI URL", subtitle: "For example, http://127.0.0.1:8317", type: "plain" },
    { key: "MANAGEMENT_KEY", title: "Management API key", subtitle: "CLIProxyAPI management secret", type: "secure" },
  ],
  async fetchUsage(ctx) {
    const baseURL = (ctx.settings.get("BASE_URL") || "").trim().replace(/\/+$/, "");
    const key = ctx.settings.getSecret("MANAGEMENT_KEY");
    if (!baseURL) throw ctx.fail.missingCredential("Set the CLIProxyAPI URL in plugin settings.");
    if (!key) throw ctx.fail.missingCredential("Set the CLIProxyAPI management key in plugin settings.");

    const authority = baseURL.match(/^https?:\/\/([^/?#]+)/i);
    if (!authority || authority[1].includes("@") || !/^https?:\/\/[^/?#]+(?:\/[^?#]*)?$/i.test(baseURL)) {
      throw ctx.fail.apiFailure("CLIProxyAPI URL must be an HTTP(S) origin or base path without credentials, query, or fragment.");
    }

    const response = await ctx.http.getJSON(`${baseURL}/v0/management/auth-files`, {
      headers: { "X-Management-Key": key },
      timeoutSeconds: 15,
    });
    const files = response.json && Array.isArray(response.json.files) ? response.json.files : null;
    if (!files) throw ctx.fail.parseFailure("CLIProxyAPI returned an unexpected auth-files response.");

    const codexAccounts = [];
    const claudeAccounts = [];
    const trackedAccounts = files.filter((file) => file && ["codex", "claude"].includes(String(file.provider || file.type || "").toLowerCase()));
    const accountState = (file) => {
      if (file.disabled || String(file.status || "").toLowerCase() === "disabled") return "Disabled";
      if (file.unavailable) return "Unavailable";
      const status = String(file.status || "").toLowerCase();
      if (status === "error") return "Error";
      if (status === "active" || status === "ready") return "Available";
      return status ? status.slice(0, 1).toUpperCase() + status.slice(1) : "Unknown";
    };
    const shortDate = (value) => {
      const date = new Date(value);
      if (!Number.isFinite(date.getTime())) return null;
      const pad = (number) => String(number).padStart(2, "0");
      return `${pad(date.getDate())}/${pad(date.getMonth() + 1)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    };
    for (const [accountIndex, file] of files.entries()) {
      const signals = file && file.quota && file.quota.signals;
      if (!signals || typeof signals !== "object") continue;
      const label = String(file.label || file.name || file.provider || "Account");
      const observedAt = Date.parse(file.quota.observed_at || "");
      for (const keyName of Object.keys(signals)) {
        const match = /^X-Codex-(?:[^-]+-)?(Primary|Secondary)-Used-Percent$/i.exec(keyName);
        if (match) {
          const rawUsed = signals[keyName];
          const used = Number(rawUsed);
          if (rawUsed === null || rawUsed === "" || !Number.isFinite(used) || used < 0 || used > 100) continue;
          const windowName = match[1].toLowerCase();
          const resetRaw = signals[keyName.replace(/Used-Percent$/i, "Reset-At")];
          const resetAfter = Number(signals[keyName.replace(/Used-Percent$/i, "Reset-After-Seconds")]);
          let resetsAt;
          if (resetRaw !== undefined && Number.isFinite(Number(resetRaw)) && Number(resetRaw) > 0 && Number.isFinite(new Date(Number(resetRaw) * 1000).getTime())) {
            resetsAt = new Date(Number(resetRaw) * 1000).toISOString();
          } else if (Number.isFinite(observedAt) && Number.isFinite(resetAfter) && resetAfter > 0) {
            const resetTime = new Date(observedAt + resetAfter * 1000);
            if (Number.isFinite(resetTime.getTime())) resetsAt = resetTime.toISOString();
          }
          codexAccounts.push({ accountIndex, label, windowName, used, resetsAt, observedAt });
        }
      }
      if (String(file.provider || file.type || "").toLowerCase() === "claude") {
        for (const [windowName, signalWindow] of [["5h", "5h"], ["7d", "7d"]]) {
          const utilizationKey = `Anthropic-Ratelimit-Unified-${signalWindow}-Utilization`;
          const utilization = Number(signals[utilizationKey]);
          if (signals[utilizationKey] == null || signals[utilizationKey] === "" || !Number.isFinite(utilization) || utilization < 0 || utilization > 1) continue;
          const reset = Number(signals[`Anthropic-Ratelimit-Unified-${signalWindow}-Reset`]);
          claudeAccounts.push({
            accountIndex,
            label,
            windowName,
            used: utilization * 100,
            resetsAt: Number.isFinite(reset) && reset > 0 && Number.isFinite(new Date(reset * 1000).getTime()) ? new Date(reset * 1000).toISOString() : undefined,
            observedAt,
          });
        }
      }
    }

    const rowsFor = (items) => {
      const grouped = new Map();
      for (const [index, file] of files.entries()) {
        const provider = String(file && (file.provider || file.type) || "").toLowerCase();
        if ((items === codexAccounts && provider === "codex") || (items === claudeAccounts && provider === "claude")) {
          grouped.set(index, { label: String(file.label || file.name || file.provider || "Account"), file });
        }
      }
      for (const item of items) {
        if (!grouped.has(item.accountIndex)) continue;
        const account = grouped.get(item.accountIndex);
        const window = item.windowName === "primary" || item.windowName === "5h" ? "short" : "weekly";
        if (!account[window] || item.used > account[window].used) account[window] = item;
      }
      const accounts = Array.from(grouped.values());
      const rows = [];
      for (const account of accounts) {
        const state = accountState(account.file);
        const row = { label: account.label, value: state };
        if (state === "Disabled" || state === "Unavailable" || state === "Error") row.severity = "warning";
        const retry = shortDate(account.file.next_retry_after);
        if (retry && Date.parse(account.file.next_retry_after) > Date.now()) row.secondaryValue = `Retry ${retry}`;
        else if (Number.isFinite(account.file.success) && Number.isFinite(account.file.failed)) {
          row.secondaryValue = `${account.file.success} ok · ${account.file.failed} failed`;
        }
        rows.push(row);
        for (const [title, item] of [["5h", account.short], ["Weekly", account.weekly]]) {
          const row = { label: title, value: item ? `${Math.round(item.used)}% used` : "Unavailable" };
          if (item) {
            row.progress = Math.max(0, Math.min(1, item.used / 100));
            if (item.used >= 90) row.severity = "critical";
            else if (item.used >= 70) row.severity = "warning";
            if (item.resetsAt) {
              row.secondaryValue = `Reset ${shortDate(item.resetsAt)}`;
            }
            if (Number.isFinite(item.observedAt) && Date.now() - item.observedAt > 3600000) {
              row.secondaryValue = `${row.secondaryValue ? row.secondaryValue + " · " : ""}Cached >1h`;
            }
          }
          rows.push(row);
        }
      }
      return rows;
    };

    const snapshot = {
      dataConfidence: "exact",
      details: [],
    };
    const available = trackedAccounts.filter((file) => accountState(file) === "Available").length;
    const attention = trackedAccounts.filter((file) => ["Unavailable", "Error"].includes(accountState(file))).length;
    const disabled = trackedAccounts.filter((file) => accountState(file) === "Disabled").length;
    const sections = [{ title: "Pool status", rows: [
      { label: "Available", value: `${available} / ${trackedAccounts.length} accounts` },
      { label: "Needs attention", value: String(attention), ...(attention ? { severity: "warning" } : {}) },
      { label: "Disabled", value: String(disabled) },
    ] }];
    for (const [provider, items] of [["Codex", codexAccounts], ["Claude", claudeAccounts]]) {
      const rows = rowsFor(items);
      for (let offset = 0; offset < rows.length; offset += 24) {
        sections.push({ title: `${provider} accounts${offset ? ` (${offset / 24 + 1})` : ""}`, rows: rows.slice(offset, offset + 24) });
      }
    }
    snapshot.details = sections.slice(0, 8);
    if (sections.length > 8) {
      const last = snapshot.details[7].rows;
      const omitted = sections.slice(8).reduce((count, section) => count + section.rows.length, 0) + 1;
      last[last.length - 1] = { label: "Additional quota windows", value: `${omitted} not shown` };
    }
    return snapshot;
  },
});
