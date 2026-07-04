#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_AUDIT_LEVEL = "high";
const DEFAULT_ALLOWLIST_PATH = "audit-allowlist.json";
const SEVERITY_ORDER = new Map([
  ["info", 0],
  ["low", 1],
  ["moderate", 2],
  ["high", 3],
  ["critical", 4],
]);

function asObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : undefined;
}

function asString(value) {
  return typeof value === "string" ? value : undefined;
}

function asNonEmptyString(value) {
  const stringValue = asString(value)?.trim();
  return stringValue ? stringValue : undefined;
}

export function formatNpmAuditErrorMessage(auditReport) {
  const root = asObject(auditReport);
  const auditError = asObject(root?.error);
  if (!auditError) {
    return undefined;
  }

  return (
    asNonEmptyString(auditError.summary) ??
    asNonEmptyString(auditError.detail) ??
    asNonEmptyString(root?.message) ??
    asNonEmptyString(auditError.message) ??
    "npm audit returned an error response."
  );
}

function normalizeAuditLevel(level) {
  const normalized = String(level ?? DEFAULT_AUDIT_LEVEL).toLowerCase();
  if (!SEVERITY_ORDER.has(normalized)) {
    throw new Error(
      `Unsupported audit level "${level}". Expected one of: ${Array.from(SEVERITY_ORDER.keys()).join(", ")}.`,
    );
  }
  return normalized;
}

function isSeverityAtLeast(severity, auditLevel) {
  const severityRank = SEVERITY_ORDER.get(String(severity ?? "").toLowerCase());
  const thresholdRank = SEVERITY_ORDER.get(auditLevel);
  return (
    severityRank !== undefined &&
    thresholdRank !== undefined &&
    severityRank >= thresholdRank
  );
}

function createFindingId(name, source) {
  if (source !== undefined && source !== null && String(source).trim() !== "") {
    return `npm:${name}:${String(source)}`;
  }
  return `npm:${name}`;
}

function appendFinding(findings, finding) {
  const previous = findings.get(finding.id);
  if (!previous) {
    findings.set(finding.id, {
      ...finding,
      affected: [...finding.affected],
    });
    return;
  }

  for (const affected of finding.affected) {
    if (!previous.affected.includes(affected)) {
      previous.affected.push(affected);
    }
  }
}

function hasSeverityAdvisoryInViaChain(
  vulnerabilities,
  packageName,
  auditLevel,
  visited = new Set(),
) {
  if (visited.has(packageName)) {
    return false;
  }
  visited.add(packageName);

  const vulnerability = asObject(vulnerabilities[packageName]);
  const via = Array.isArray(vulnerability?.via) ? vulnerability.via : [];

  return via.some((item) => {
    const advisory = asObject(item);
    if (advisory) {
      return isSeverityAtLeast(asString(advisory.severity), auditLevel);
    }

    return (
      typeof item === "string" &&
      hasSeverityAdvisoryInViaChain(vulnerabilities, item, auditLevel, visited)
    );
  });
}

export function collectAuditFindings(report, auditLevel = DEFAULT_AUDIT_LEVEL) {
  const normalizedAuditLevel = normalizeAuditLevel(auditLevel);
  const root = asObject(report);
  const vulnerabilities = asObject(root?.vulnerabilities);
  if (!vulnerabilities) {
    return [];
  }

  const findings = new Map();

  for (const [packageName, rawVulnerability] of Object.entries(
    vulnerabilities,
  )) {
    const vulnerability = asObject(rawVulnerability);
    if (!vulnerability) {
      continue;
    }

    const vulnerabilityName = asString(vulnerability.name) ?? packageName;
    const vulnerabilitySeverity = asString(vulnerability.severity);
    const via = Array.isArray(vulnerability.via) ? vulnerability.via : [];
    const advisoryObjects = via
      .map((item) => asObject(item))
      .filter(Boolean)
      .filter((advisory) =>
        isSeverityAtLeast(asString(advisory.severity), normalizedAuditLevel),
      );

    for (const advisory of advisoryObjects) {
      const advisoryName = asString(advisory.name) ?? vulnerabilityName;
      appendFinding(findings, {
        id: createFindingId(advisoryName, advisory.source),
        packageName: advisoryName,
        severity:
          asString(advisory.severity) ?? vulnerabilitySeverity ?? "unknown",
        title: asString(advisory.title) ?? `npm audit reported ${advisoryName}`,
        url: asString(advisory.url),
        range: asString(advisory.range) ?? asString(vulnerability.range),
        affected: [vulnerabilityName],
      });
    }

    const viaPackages = via.filter((item) => typeof item === "string");
    const coveredByViaAdvisory = viaPackages.some((viaPackage) =>
      hasSeverityAdvisoryInViaChain(
        vulnerabilities,
        viaPackage,
        normalizedAuditLevel,
      ),
    );

    if (
      advisoryObjects.length === 0 &&
      !coveredByViaAdvisory &&
      isSeverityAtLeast(vulnerabilitySeverity, normalizedAuditLevel)
    ) {
      appendFinding(findings, {
        id: createFindingId(vulnerabilityName),
        packageName: vulnerabilityName,
        severity: vulnerabilitySeverity ?? "unknown",
        title:
          viaPackages.length > 0
            ? `Transitive vulnerability via ${viaPackages.join(", ")}`
            : `npm audit reported ${vulnerabilityName}`,
        url: undefined,
        range: asString(vulnerability.range),
        affected: [vulnerabilityName],
      });
    }
  }

  return Array.from(findings.values()).sort((left, right) => {
    const severityDelta =
      (SEVERITY_ORDER.get(String(right.severity).toLowerCase()) ?? -1) -
      (SEVERITY_ORDER.get(String(left.severity).toLowerCase()) ?? -1);
    if (severityDelta !== 0) {
      return severityDelta;
    }
    return left.id.localeCompare(right.id);
  });
}

function parseExpiryDate(expires) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(expires);
  if (!match) {
    return undefined;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const expiresAt = new Date(Date.UTC(year, month - 1, day, 23, 59, 59, 999));
  if (
    expiresAt.getUTCFullYear() !== year ||
    expiresAt.getUTCMonth() !== month - 1 ||
    expiresAt.getUTCDate() !== day
  ) {
    return undefined;
  }
  return expiresAt;
}

export function normalizeAllowlist(allowlist, now = new Date()) {
  const root = asObject(allowlist);
  const errors = [];
  const entries = [];

  if (!root) {
    return { entries, errors: ["Audit allowlist must be a JSON object."] };
  }

  if (root.version !== 1) {
    errors.push('Audit allowlist must set "version": 1.');
  }

  if (!Array.isArray(root.entries)) {
    errors.push('Audit allowlist must set "entries" to an array.');
    return { entries, errors };
  }

  root.entries.forEach((rawEntry, index) => {
    const entry = asObject(rawEntry);
    const prefix = `allowlist entry ${index + 1}`;
    if (!entry) {
      errors.push(`${prefix} must be an object.`);
      return;
    }

    const id = asString(entry.id)?.trim();
    const expires = asString(entry.expires)?.trim();
    const reason = asString(entry.reason)?.trim();

    if (!id) {
      errors.push(`${prefix} must include a non-empty "id".`);
    }
    if (!reason) {
      errors.push(`${prefix} must include a non-empty "reason".`);
    }
    if (!expires) {
      errors.push(
        `${prefix} must include an "expires" date in YYYY-MM-DD format.`,
      );
    }

    const expiresAt = expires ? parseExpiryDate(expires) : undefined;
    if (expires && !expiresAt) {
      errors.push(
        `${prefix} has invalid "expires" date "${expires}". Use YYYY-MM-DD.`,
      );
    }
    if (expiresAt && now.getTime() > expiresAt.getTime()) {
      errors.push(`${prefix} (${id ?? "missing id"}) expired on ${expires}.`);
    }

    if (id && reason && expiresAt && now.getTime() <= expiresAt.getTime()) {
      entries.push({ id, expires, reason });
    }
  });

  return { entries, errors };
}

export function evaluateAuditGate(report, allowlist, options = {}) {
  const auditLevel = normalizeAuditLevel(options.auditLevel);
  const findings = collectAuditFindings(report, auditLevel);
  const { entries, errors: allowlistErrors } = normalizeAllowlist(
    allowlist,
    options.now,
  );
  const activeAllowlist = new Map(entries.map((entry) => [entry.id, entry]));
  const allowedFindings = findings.filter((finding) =>
    activeAllowlist.has(finding.id),
  );
  const unapprovedFindings = findings.filter(
    (finding) => !activeAllowlist.has(finding.id),
  );
  const usedAllowlistIds = new Set(
    allowedFindings.map((finding) => finding.id),
  );
  const unusedAllowlistIds = entries
    .map((entry) => entry.id)
    .filter((id) => !usedAllowlistIds.has(id));

  return {
    ok: allowlistErrors.length === 0 && unapprovedFindings.length === 0,
    auditLevel,
    findings,
    allowedFindings,
    unapprovedFindings,
    allowlistErrors,
    unusedAllowlistIds,
  };
}

function loadJsonFile(filePath, fallback) {
  if (!existsSync(filePath)) {
    return fallback;
  }

  const content = readFileSync(filePath, "utf8");
  return JSON.parse(content);
}

function runNpmAudit(auditLevel) {
  const result = spawnSync(
    "npm",
    ["audit", "--json", `--audit-level=${auditLevel}`],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();

  if (!stdout) {
    if (result.status === 0) {
      return {};
    }
    throw new Error(
      result.error?.message ||
        stderr ||
        "npm audit failed without JSON output.",
    );
  }

  let auditReport;
  try {
    auditReport = JSON.parse(stdout);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse npm audit JSON output: ${message}`, {
      cause: error,
    });
  }

  const auditErrorMessage = formatNpmAuditErrorMessage(auditReport);
  if (auditErrorMessage) {
    throw new Error(`npm audit failed: ${auditErrorMessage}`);
  }
  return auditReport;
}

function parseArgs(args) {
  const options = {
    auditLevel: DEFAULT_AUDIT_LEVEL,
    allowlistPath: DEFAULT_ALLOWLIST_PATH,
  };

  for (const arg of args) {
    if (arg.startsWith("--audit-level=")) {
      options.auditLevel = arg.slice("--audit-level=".length);
      continue;
    }
    if (arg.startsWith("--allowlist=")) {
      options.allowlistPath = arg.slice("--allowlist=".length);
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    throw new Error(`Unknown argument "${arg}".`);
  }

  options.auditLevel = normalizeAuditLevel(options.auditLevel);
  return options;
}

function formatFinding(finding) {
  const parts = [
    `${finding.id} [${finding.severity}]`,
    finding.title,
    `affected: ${finding.affected.join(", ")}`,
  ];
  if (finding.range) {
    parts.push(`range: ${finding.range}`);
  }
  if (finding.url) {
    parts.push(finding.url);
  }
  return parts.join(" | ");
}

function printHelp() {
  console.log(`Usage: node scripts/audit-gate.mjs [--audit-level=high] [--allowlist=audit-allowlist.json]

Runs npm audit and fails when ${DEFAULT_AUDIT_LEVEL}+ vulnerabilities are not covered by an active allowlist entry.
Allowlist IDs use the format npm:<package>:<advisory-source>, for example npm:example:1234567.`);
}

function printEvaluation(evaluation) {
  for (const error of evaluation.allowlistErrors) {
    console.error(`audit allowlist error: ${error}`);
  }

  if (evaluation.unapprovedFindings.length > 0) {
    console.error(
      `npm audit gate failed: ${evaluation.unapprovedFindings.length} unallowlisted ${evaluation.auditLevel}+ vulnerability finding(s).`,
    );
    for (const finding of evaluation.unapprovedFindings) {
      console.error(`- ${formatFinding(finding)}`);
    }
  }

  if (evaluation.allowedFindings.length > 0) {
    console.log(
      `npm audit gate: ${evaluation.allowedFindings.length} ${evaluation.auditLevel}+ finding(s) covered by active allowlist entries.`,
    );
    for (const finding of evaluation.allowedFindings) {
      console.log(`- ${formatFinding(finding)}`);
    }
  }

  if (evaluation.unusedAllowlistIds.length > 0) {
    console.warn(
      `npm audit gate: unused active allowlist entr${evaluation.unusedAllowlistIds.length === 1 ? "y" : "ies"}: ${evaluation.unusedAllowlistIds.join(", ")}`,
    );
  }

  if (evaluation.ok) {
    console.log(
      `npm audit gate passed: no unallowlisted ${evaluation.auditLevel}+ vulnerability findings.`,
    );
  }
}

export function runCli(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  if (options.help) {
    printHelp();
    return 0;
  }

  const allowlistPath = path.resolve(process.cwd(), options.allowlistPath);
  const auditReport = runNpmAudit(options.auditLevel);
  const allowlist = loadJsonFile(allowlistPath, { version: 1, entries: [] });
  const evaluation = evaluateAuditGate(auditReport, allowlist, {
    auditLevel: options.auditLevel,
  });

  printEvaluation(evaluation);
  return evaluation.ok ? 0 : 1;
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  try {
    process.exitCode = runCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
