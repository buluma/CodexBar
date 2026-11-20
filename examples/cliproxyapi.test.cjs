const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

let provider;
vm.runInNewContext(fs.readFileSync(`${__dirname}/cliproxyapi.js`, "utf8"), {
  defineProvider(value) { provider = value; },
});

const fetch = (files) => provider.fetchUsage({
  settings: { get: () => "http://127.0.0.1:8317", getSecret: () => "fixture" },
  http: { getJSON: async () => ({ json: { files } }) },
  fail: { parseFailure: (message) => new Error(message) },
});

async function main() {
  const observed = "2026-01-01T00:00:00Z";
  const files = [
    { name: "codex", provider: "codex", status: "active", success: 12, failed: 1, quota: { observed_at: observed, signals: {
      "X-Codex-Primary-Used-Percent": "0", "X-Codex-Primary-Reset-After-Seconds": "3600",
      "X-Codex-Secondary-Used-Percent": "63",
    } } },
    { name: "claude", provider: "claude", unavailable: true, quota: { observed_at: observed, signals: {
      "Anthropic-Ratelimit-Unified-5h-Utilization": "0.04",
      "Anthropic-Ratelimit-Unified-7d-Utilization": "0.32",
    } } },
  ];
  const result = await fetch(files);
  assert.equal(result.details.length, 3);
  assert.equal(result.details[0].rows[0].value, "1 / 2 accounts");
  assert.equal(result.details[0].rows[1].value, "1");
  assert.equal(result.details[1].rows[0].secondaryValue, "12 ok · 1 failed");
  assert.equal(result.details[1].rows[1].value, "0% used");
  assert.equal(result.details[1].rows[1].progress, 0);
  assert.match(result.details[1].rows[1].secondaryValue, /Cached >1h/);
  assert.equal(result.details[1].rows[2].value, "63% used");
  assert.equal(result.details[2].rows[0].value, "Unavailable");
  assert.equal(result.details[2].rows[1].value, "4% used");
  assert.equal(result.details[2].rows[2].value, "32% used");
  assert.equal((await fetch(files)).details[1].rows[1].secondaryValue, result.details[1].rows[1].secondaryValue);

  const many = Array.from({ length: 25 }, (_, i) => ({ ...files[0], name: `account-${i}` }));
  const expanded = await fetch(many);
  assert.equal(expanded.details.length, 5);
  assert.equal(expanded.details.slice(1).reduce((count, section) => count + section.rows.length, 0), 75);
  const invalid = await fetch([{ name: "invalid", provider: "claude", quota: { signals: {
    "Anthropic-Ratelimit-Unified-5h-Utilization": "", "Anthropic-Ratelimit-Unified-7d-Utilization": "invalid",
  } } }]);
  assert.equal(invalid.details[1].rows[1].value, "Unavailable");
  await assert.rejects(provider.fetchUsage({
    settings: { get: () => "http://127.0.0.1:8317", getSecret: () => "fixture" },
    http: { getJSON: async () => ({ json: {} }) },
    fail: { parseFailure: (message) => new Error(message) },
  }), /unexpected auth-files/);
  process.stdout.write("CLIProxyAPI plugin checks passed\n");
}

main().catch((error) => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
