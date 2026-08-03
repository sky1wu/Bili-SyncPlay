import assert from "node:assert/strict";
import test from "node:test";

import {
  collectAuditFindings,
  evaluateAuditGate,
  formatNpmAuditErrorMessage,
  getNpmAuditInvocation,
  normalizeAllowlist,
} from "./audit-gate.mjs";

const NOW = new Date("2026-04-24T12:00:00.000Z");

test("getNpmAuditInvocation runs npm through Node on Windows", () => {
  assert.deepEqual(
    getNpmAuditInvocation("win32", "C:\\node\\node.exe", "C:\\npm\\npm-cli.js"),
    {
      command: "C:\\node\\node.exe",
      prefixArgs: ["C:\\npm\\npm-cli.js"],
    },
  );
  assert.deepEqual(getNpmAuditInvocation("linux"), {
    command: "npm",
    prefixArgs: [],
  });
});

function createAuditReport() {
  return {
    vulnerabilities: {
      "@demo/app": {
        name: "@demo/app",
        severity: "high",
        via: ["demo-vulnerable"],
        range: "1.0.0",
      },
      "demo-vulnerable": {
        name: "demo-vulnerable",
        severity: "high",
        via: [
          {
            source: 1234567,
            name: "demo-vulnerable",
            dependency: "demo-vulnerable",
            title: "Prototype pollution in demo-vulnerable",
            severity: "high",
            range: "<1.0.1",
            url: "https://github.com/advisories/GHSA-demo",
          },
        ],
        range: "<1.0.1",
      },
      "demo-low": {
        name: "demo-low",
        severity: "moderate",
        via: [
          {
            source: 7654321,
            name: "demo-low",
            title: "Moderate demo advisory",
            severity: "moderate",
            range: "<2.0.0",
          },
        ],
        range: "<2.0.0",
      },
    },
  };
}

test("collectAuditFindings returns high advisory IDs without duplicating transitive wrappers", () => {
  const findings = collectAuditFindings(createAuditReport(), "high");

  assert.deepEqual(
    findings.map((finding) => finding.id),
    ["npm:demo-vulnerable:1234567"],
  );
  assert.deepEqual(findings[0]?.affected.sort(), ["demo-vulnerable"]);
});

test("collectAuditFindings follows nested via package chains before adding fallback IDs", () => {
  const findings = collectAuditFindings(
    {
      vulnerabilities: {
        "demo-app": {
          name: "demo-app",
          severity: "high",
          via: ["demo-wrapper"],
          range: "1.0.0",
        },
        "demo-wrapper": {
          name: "demo-wrapper",
          severity: "high",
          via: ["demo-vulnerable"],
          range: "1.0.0",
        },
        "demo-vulnerable": {
          name: "demo-vulnerable",
          severity: "high",
          via: [
            {
              source: 2345678,
              name: "demo-vulnerable",
              title: "Nested high advisory",
              severity: "high",
              range: "<1.0.1",
            },
          ],
          range: "<1.0.1",
        },
      },
    },
    "high",
  );

  assert.deepEqual(
    findings.map((finding) => finding.id),
    ["npm:demo-vulnerable:2345678"],
  );
});

test("evaluateAuditGate passes when high findings are covered by active allowlist entries", () => {
  const evaluation = evaluateAuditGate(
    createAuditReport(),
    {
      version: 1,
      entries: [
        {
          id: "npm:demo-vulnerable:1234567",
          expires: "2026-04-30",
          reason: "Waiting for upstream patch to be released.",
        },
      ],
    },
    { now: NOW },
  );

  assert.equal(evaluation.ok, true);
  assert.equal(evaluation.allowedFindings.length, 1);
  assert.equal(evaluation.unapprovedFindings.length, 0);
});

test("evaluateAuditGate fails for unallowlisted high findings", () => {
  const evaluation = evaluateAuditGate(
    createAuditReport(),
    { version: 1, entries: [] },
    { now: NOW },
  );

  assert.equal(evaluation.ok, false);
  assert.deepEqual(
    evaluation.unapprovedFindings.map((finding) => finding.id),
    ["npm:demo-vulnerable:1234567"],
  );
});

test("normalizeAllowlist rejects expired or incomplete entries", () => {
  const result = normalizeAllowlist(
    {
      version: 1,
      entries: [
        {
          id: "npm:demo-vulnerable:1234567",
          expires: "2026-04-23",
          reason: "Temporary exception.",
        },
        {
          id: "npm:missing-reason:123",
          expires: "2026-04-30",
        },
      ],
    },
    NOW,
  );

  assert.deepEqual(result.entries, []);
  assert.match(result.errors.join("\n"), /expired on 2026-04-23/);
  assert.match(result.errors.join("\n"), /non-empty "reason"/);
});

test("formatNpmAuditErrorMessage falls back to top-level message when nested fields are blank", () => {
  assert.equal(
    formatNpmAuditErrorMessage({
      error: {
        summary: "",
        detail: "   ",
      },
      message: "403 Forbidden - audit endpoint rejected the request.",
    }),
    "403 Forbidden - audit endpoint rejected the request.",
  );
});

test("collectAuditFindings falls back to package IDs when npm omits advisory objects", () => {
  const findings = collectAuditFindings(
    {
      vulnerabilities: {
        "demo-wrapper": {
          name: "demo-wrapper",
          severity: "critical",
          via: ["missing-advisory-package"],
          range: "<3.0.0",
        },
      },
    },
    "high",
  );

  assert.deepEqual(
    findings.map((finding) => finding.id),
    ["npm:demo-wrapper"],
  );
});
