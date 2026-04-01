#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import * as fs from "fs";
import * as path from "path";
import * as http from "http";
// @ts-ignore — JSON import with attribute; works in Node 22+ and esbuild bundler
import governanceRules from "./governance_scan_rules_v1.json" with { type: "json" };

// ━━━ Helpers ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function getNestedValue(fieldPath: string, obj: any): any {
  let resolved = fieldPath;

  // Replace [model] with actual primary model name
  if (resolved.includes("[model]")) {
    const primary = getNestedValue("agents.defaults.model.primary", obj);
    if (!primary) return undefined;
    resolved = resolved.replace("[model]", primary);
  }

  // Replace [agent_name] with agent name
  if (resolved.includes("[agent_name]")) {
    if (!obj?.name) return undefined;
    resolved = resolved.replace("[agent_name]", obj.name);
  }

  return resolved.split(".").reduce((acc: any, key: string) => acc?.[key], obj);
}

function resolveWorkspaceFile(fieldPath: string, config: any): string | null {
  if (fieldPath.startsWith("workspace/")) {
    const rel = fieldPath.substring("workspace/".length);
    if (config.workspace) return path.join(config.workspace, rel);
  }
  return null;
}

function readWorkspaceFile(fieldPath: string, config: any): string | null {
  const filePath = resolveWorkspaceFile(fieldPath, config);
  if (filePath) {
    try {
      if (fs.existsSync(filePath)) return fs.readFileSync(filePath, "utf-8");
    } catch { /* fall through */ }
  }
  if (config.workspace_files) {
    const key = fieldPath.startsWith("workspace/")
      ? fieldPath.substring("workspace/".length)
      : fieldPath;
    if (config.workspace_files[key] !== undefined) return config.workspace_files[key];
  }
  return null;
}

function fileExistsInWorkspace(fieldPath: string, config: any): boolean {
  const filePath = resolveWorkspaceFile(fieldPath, config);
  if (filePath) {
    try { return fs.existsSync(filePath); } catch { /* fall through */ }
  }
  if (config.workspace_files) {
    const key = fieldPath.startsWith("workspace/")
      ? fieldPath.substring("workspace/".length)
      : fieldPath;
    return key in config.workspace_files;
  }
  return false;
}

// ━━━ Condition Evaluators ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function evalExistsAndNonEmpty(fieldPath: string, config: any): boolean {
  const v = getNestedValue(fieldPath, config);
  if (Array.isArray(v)) return v.length > 0;
  return v !== null && v !== undefined && v !== "";
}

function evalExistsAndInList(fieldPath: string, validValues: string[], config: any): boolean {
  return validValues.includes(getNestedValue(fieldPath, config));
}

function evalFileExists(rule: any, config: any): boolean {
  if (rule.file_path_pattern) {
    const ws = config.workspace;
    if (!ws) {
      const fileName = rule.file_path_pattern.replace("*/", "");
      return config.workspace_files ? fileName in config.workspace_files : false;
    }
    const resolved = rule.file_path_pattern.replace("*", ws);
    try { return fs.existsSync(resolved); } catch { return false; }
  }
  return fileExistsInWorkspace(rule.field_path, config);
}

function evalFileContains(fieldPath: string, searchTerms: string[], config: any): boolean {
  if (fieldPath.includes("YYYY-MM-DD")) {
    return evalFileContainsDatePattern(fieldPath, searchTerms, config);
  }
  const content = readWorkspaceFile(fieldPath, config);
  if (!content) return false;
  return searchTerms.some((t) => content.includes(t));
}

function evalFileContainsDatePattern(
  fieldPath: string,
  searchTerms: string[],
  config: any
): boolean {
  if (config.workspace_files) {
    const pat = /^memory\/\d{4}-\d{2}-\d{2}\.md$/;
    for (const [k, v] of Object.entries(config.workspace_files)) {
      if (pat.test(k) && typeof v === "string") {
        if (searchTerms.some((t) => (v as string).includes(t))) return true;
      }
    }
    return false;
  }
  if (!config.workspace) return false;
  const dir = path.join(config.workspace, "memory");
  try {
    if (!fs.existsSync(dir)) return false;
    const files = fs
      .readdirSync(dir)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .sort()
      .reverse();
    if (files.length === 0) return false;
    const content = fs.readFileSync(path.join(dir, files[0]), "utf-8");
    return searchTerms.some((t) => content.includes(t));
  } catch {
    return false;
  }
}

function evalEqualsTrue(fieldPath: string, config: any): boolean {
  return getNestedValue(fieldPath, config) === true;
}

function evalEqualsFalse(fieldPath: string, config: any): boolean {
  return getNestedValue(fieldPath, config) === false;
}

function evalFileExistsPattern(fieldPath: string, config: any): boolean {
  if (config.workspace_files) {
    const pat = /^memory\/\d{4}-\d{2}-\d{2}\.md$/;
    return Object.keys(config.workspace_files).some((k) => pat.test(k));
  }
  if (!config.workspace) return false;
  const dir = path.join(config.workspace, "memory");
  try {
    if (!fs.existsSync(dir)) return false;
    return fs.readdirSync(dir).some((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f));
  } catch {
    return false;
  }
}

function evalFileExistsAndRecent(
  fieldPath: string,
  maxAgeDays: number,
  config: any
): boolean {
  const filePath = resolveWorkspaceFile(fieldPath, config);
  if (filePath) {
    try {
      if (!fs.existsSync(filePath)) return false;
      const age = (Date.now() - fs.statSync(filePath).mtimeMs) / 86_400_000;
      return age <= maxAgeDays;
    } catch { /* fall through */ }
  }
  if (config.workspace_files) {
    const key = fieldPath.startsWith("workspace/")
      ? fieldPath.substring("workspace/".length)
      : fieldPath;
    return key in config.workspace_files; // Can't check age, just existence
  }
  return false;
}

function evalNoApiKeysInFiles(
  _fieldPath: string,
  forbidden: string[],
  config: any
): boolean {
  if (config.workspace_files) {
    for (const content of Object.values(config.workspace_files)) {
      if (typeof content === "string") {
        for (const p of forbidden) {
          if (content.includes(p)) return false;
        }
      }
    }
    return true;
  }
  if (!config.workspace) return true;
  try {
    const check = ["SOUL.md", "MEMORY.md", "CLAUDE.md", "AGENTS.md", ".env"];
    for (const f of check) {
      const fp = path.join(config.workspace, f);
      if (fs.existsSync(fp)) {
        const content = fs.readFileSync(fp, "utf-8");
        for (const p of forbidden) {
          if (content.includes(p)) return false;
        }
      }
    }
    return true;
  } catch {
    return true;
  }
}

function evalAuthProfilesExist(required: string[], config: any): boolean {
  const auth = config.auth || getNestedValue("openclaw.auth", config);
  if (!auth) return false;
  return required.every((profile) => {
    const [provider] = profile.split(":");
    return auth[provider] || auth[profile];
  });
}

function evalRichTelegramConfigured(senderId: string, config: any): boolean {
  const tg = config.telegram || config.notifications?.telegram;
  if (tg && (tg.chat_id === senderId || tg.sender_id === senderId)) return true;
  const mem = readWorkspaceFile("workspace/MEMORY.md", config);
  if (mem && mem.includes(senderId)) return true;
  const soul = readWorkspaceFile("workspace/SOUL.md", config);
  if (soul && soul.toLowerCase().includes("telegram")) return true;
  return false;
}

function evalRing0LowThinking(maxVal: string, config: any): boolean {
  if (config.ring !== "Ring 0") return true;
  const model = getNestedValue("agents.defaults.model.primary", config);
  if (!model) return true;
  const thinking = getNestedValue(
    `agents.defaults.models.${model}.params.thinking`,
    config
  );
  if (!thinking) return true;
  const levels = ["off", "none", "low", "medium", "high"];
  return levels.indexOf(thinking) <= levels.indexOf(maxVal);
}

function evalModelContext200k(_fieldPath: string, config: any): boolean {
  const model = getNestedValue("agents.defaults.model.primary", config);
  if (!model) return false;
  const large = [
    "anthropic/claude-sonnet-4-5-20250929",
    "anthropic/claude-opus-4-1-20250805",
    "anthropic/claude-opus-4-6",
    "anthropic/claude-haiku-4-5-20251001",
    "google/gemini-2.0-flash",
  ];
  return large.some((m) => model.includes(m) || m.includes(model));
}

function evalToolAccessMatchesRing(rule: any, config: any): boolean {
  const ring = config.ring;
  if (!ring) return false;
  if (
    (ring === "Ring 2" || ring === "Ring 3") &&
    config.elevated?.enabled === true
  )
    return false;
  return true;
}

function evalAgentSandboxSet(config: any): boolean {
  const sb =
    getNestedValue(`agents.${config.name}.sandbox`, config) ||
    getNestedValue("sandbox", config) ||
    getNestedValue("agents.defaults.sandbox", config);
  return sb === "inherit" || sb === "require";
}

function evalFileExistsOrEmpty(fieldPath: string, config: any): boolean {
  return fileExistsInWorkspace(fieldPath, config);
}

function evalFileExistsAndReadable(_fieldPath: string, _config: any): boolean {
  // Session log directory check — skipped in v1 (default pass per spec)
  return true;
}

// ━━━ Rule Evaluator ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function evaluateRule(rule: any, config: any): boolean {
  // applies_to_ring filter
  if (rule.applies_to_ring && Array.isArray(rule.applies_to_ring)) {
    if (!rule.applies_to_ring.includes(config.ring)) return true;
  }

  try {
    switch (rule.condition) {
      case "exists_and_non_empty":
        return evalExistsAndNonEmpty(rule.field_path, config);
      case "exists_and_in_list":
        return evalExistsAndInList(rule.field_path, rule.valid_values, config);
      case "file_exists":
        return evalFileExists(rule, config);
      case "file_contains":
        return evalFileContains(rule.field_path, rule.search_terms, config);
      case "equals_true":
        return evalEqualsTrue(rule.field_path, config);
      case "equals_false":
        return evalEqualsFalse(rule.field_path, config);
      case "file_exists_pattern":
        return evalFileExistsPattern(rule.field_path, config);
      case "file_exists_and_recent":
        return evalFileExistsAndRecent(rule.field_path, rule.max_age_days, config);
      case "no_api_keys_in_files":
        return evalNoApiKeysInFiles(rule.field_path, rule.forbidden_patterns, config);
      case "auth_profiles_exist":
        return evalAuthProfilesExist(rule.required_profiles, config);
      case "rich_telegram_configured":
        return evalRichTelegramConfigured(rule.rich_sender_id, config);
      case "ring_0_has_low_thinking":
        return evalRing0LowThinking(rule.max_thinking_value, config);
      case "model_context_200k":
        return evalModelContext200k(rule.field_path, config);
      case "tool_access_matches_ring":
        return evalToolAccessMatchesRing(rule, config);
      case "agent_sandbox_set":
        return evalAgentSandboxSet(config);
      case "file_exists_or_empty":
        return evalFileExistsOrEmpty(rule.field_path, config);
      case "file_exists_and_readable":
        return evalFileExistsAndReadable(rule.field_path, config);
      default:
        console.error(
          `Rule ${rule.rule_id}: unknown condition '${rule.condition}', skipping`
        );
        return true;
    }
  } catch (err) {
    console.error(`Rule ${rule.rule_id} error:`, err);
    return false;
  }
}

// ━━━ Scoring ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

interface CategoryResult {
  category_id: number;
  category_name: string;
  score: number;
  max_score: number;
  status: "PASS" | "WARN" | "FAIL";
  findings: string[];
  recommendations: string[];
  passed_rules: string[];
  failed_rules: string[];
}

function scoreCategory(category: any, config: any): CategoryResult {
  let score = 0;
  const passed: string[] = [];
  const failed: string[] = [];
  const findings: string[] = [];
  const recs: string[] = [];

  for (const rule of category.rules) {
    if (evaluateRule(rule, config)) {
      score += rule.score_if_pass;
      passed.push(rule.rule_id);
    } else {
      score += rule.score_if_fail;
      failed.push(rule.rule_id);
      findings.push(rule.finding_if_fail);
      recs.push(rule.recommendation);
    }
  }

  score = Math.max(0, Math.min(score, category.max_score));
  const pct = (score / category.max_score) * 100;

  return {
    category_id: category.category_id,
    category_name: category.category_name,
    score,
    max_score: category.max_score,
    status: pct >= 70 ? "PASS" : pct >= 40 ? "WARN" : "FAIL",
    findings,
    recommendations: recs,
    passed_rules: passed,
    failed_rules: failed,
  };
}

function letterGrade(s: number): "A" | "B" | "C" | "D" | "F" {
  if (s >= 85) return "A";
  if (s >= 70) return "B";
  if (s >= 55) return "C";
  if (s >= 40) return "D";
  return "F";
}

function overallStatus(s: number): "HEALTHY" | "DEGRADED" | "FAILING" {
  if (s >= 70) return "HEALTHY";
  if (s >= 50) return "DEGRADED";
  return "FAILING";
}

// ━━━ Tool 1: scan_agent_config ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function scanAgentConfig(agentConfig: any) {
  const categories: CategoryResult[] = governanceRules.categories.map(
    (cat: any) => scoreCategory(cat, agentConfig)
  );

  const total = categories.reduce((s, c) => s + c.score, 0);
  let critViolations = 0;
  let highViolations = 0;
  let totalPassed = 0;
  let totalFailed = 0;

  for (const cat of governanceRules.categories) {
    const result = categories.find(
      (c) => c.category_id === cat.category_id
    )!;
    for (const rule of cat.rules) {
      if (result.passed_rules.includes(rule.rule_id)) {
        totalPassed++;
      } else if (result.failed_rules.includes(rule.rule_id)) {
        totalFailed++;
        if (rule.severity === "CRITICAL") critViolations++;
        if (rule.severity === "HIGH") highViolations++;
      }
    }
  }

  return {
    agent_name: agentConfig.name || "unknown",
    scan_timestamp: new Date().toISOString(),
    overall_score: total,
    letter_grade: letterGrade(total),
    status: overallStatus(total),
    categories,
    summary: {
      total_rules_evaluated: totalPassed + totalFailed,
      total_rules_passed: totalPassed,
      total_rules_failed: totalFailed,
      critical_violations: critViolations,
      high_severity_violations: highViolations,
    },
  };
}

// ━━━ Tool 2: scan_multi_agent_system ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function evaluateCrossAgentRules(agents: any[]) {
  const results: {
    rule_id: string;
    severity: string;
    passed: boolean;
    finding?: string;
    recommendation?: string;
  }[] = [];

  // XA-1: No multiple agents with unrestricted elevated permissions
  const elevated = agents.filter((a) => a.elevated?.enabled === true);
  results.push({
    rule_id: "XA-1",
    severity: "CRITICAL",
    passed: elevated.length <= 1,
    finding:
      elevated.length > 1
        ? `${elevated.length} agents have unrestricted elevated permissions: ${elevated.map((a) => a.name).join(", ")}`
        : undefined,
    recommendation:
      elevated.length > 1
        ? "Limit elevated permissions to at most 1 agent (typically Warren)"
        : undefined,
  });

  // XA-2: No Ring 2/3 agent writing to Ring 0 workspace
  const ring0Ws = agents
    .filter((a) => a.ring === "Ring 0")
    .map((a) => a.workspace)
    .filter(Boolean);
  const ring23 = agents.filter(
    (a) => a.ring === "Ring 2" || a.ring === "Ring 3"
  );
  const xa2Violators = ring23.filter(
    (a) =>
      a.workspace &&
      ring0Ws.some((w: string) => a.workspace.startsWith(path.dirname(w)))
  );
  results.push({
    rule_id: "XA-2",
    severity: "CRITICAL",
    passed: xa2Violators.length === 0,
    finding:
      xa2Violators.length > 0
        ? `Ring 2/3 agents with Ring 0 workspace access: ${xa2Violators.map((a: any) => a.name).join(", ")}`
        : undefined,
    recommendation:
      xa2Violators.length > 0
        ? "Restrict Ring 2/3 agents from Ring 0 workspace paths"
        : undefined,
  });

  // XA-3: No duplicate agent names
  const names = agents.map((a) => a.name).filter(Boolean);
  const hasDupes = new Set(names).size !== names.length;
  const dupes = names.filter((n, i) => names.indexOf(n) !== i);
  results.push({
    rule_id: "XA-3",
    severity: "HIGH",
    passed: !hasDupes,
    finding: hasDupes
      ? `Duplicate agent names: ${[...new Set(dupes)].join(", ")}`
      : undefined,
    recommendation: hasDupes ? "Ensure all agents have unique names" : undefined,
  });

  // XA-4: No circular escalation paths (simplified — default pass in v1)
  results.push({
    rule_id: "XA-4",
    severity: "MEDIUM",
    passed: true,
    finding: undefined,
    recommendation: undefined,
  });

  // XA-5: All agents reference Warren for governance escalation
  const noWarren: string[] = [];
  for (const a of agents) {
    const mem = readWorkspaceFile("workspace/MEMORY.md", a);
    if (!mem || !mem.toLowerCase().includes("warren")) {
      noWarren.push(a.name || "unnamed");
    }
  }
  results.push({
    rule_id: "XA-5",
    severity: "LOW",
    passed: noWarren.length === 0,
    finding:
      noWarren.length > 0
        ? `Agents without Warren escalation reference: ${noWarren.join(", ")}`
        : undefined,
    recommendation:
      noWarren.length > 0
        ? "Add agent:warren:main to each agent's MEMORY.md"
        : undefined,
  });

  return results;
}

function scanMultiAgentSystem(agents: any[], orchestration?: any) {
  const reports = agents.map((a) => scanAgentConfig(a));
  const cross = evaluateCrossAgentRules(agents);

  const crossPassed = cross.filter((r) => r.passed).length;
  const crossFailed = cross.filter((r) => !r.passed).length;
  const findings = cross
    .filter((r) => !r.passed && r.finding)
    .map((r) => `${r.rule_id} FAIL: ${r.finding}`);
  const recs = cross
    .filter((r) => !r.passed && r.recommendation)
    .map((r) => r.recommendation!);

  const avg =
    reports.reduce((s, r) => s + r.overall_score, 0) / reports.length;
  const penalty = cross
    .filter((r) => !r.passed)
    .reduce((s, r) => {
      if (r.severity === "CRITICAL") return s + 10;
      if (r.severity === "HIGH") return s + 5;
      if (r.severity === "MEDIUM") return s + 2;
      return s + 1;
    }, 0);
  const sysScore = Math.max(0, Math.round(avg - penalty));

  return {
    scan_timestamp: new Date().toISOString(),
    system_score: sysScore,
    system_status: overallStatus(sysScore),
    agents: reports.map((r) => ({
      agent_name: r.agent_name,
      overall_score: r.overall_score,
      letter_grade: r.letter_grade,
      status: r.status,
    })),
    cross_agent_analysis: {
      rules_evaluated: cross.length,
      rules_passed: crossPassed,
      rules_failed: crossFailed,
      findings,
      recommendations: recs,
    },
    critical_system_risks: cross
      .filter((r) => !r.passed && r.severity === "CRITICAL")
      .map((r) => `${r.rule_id}: ${r.finding}`),
  };
}

// ━━━ Tool 3: get_governance_checklist ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const checklists: Record<string, any> = {
  build: {
    agent_type: "build",
    checklist: [
      {
        category: "Identity & Charter",
        items: [
          "Unique agent name assigned",
          "Ring 1 or Ring 2 (build agents never Ring 0)",
          "SOUL.md documents build scope and authority limits",
          "Charter explicitly states 'no production deployment without Rich approval'",
        ],
      },
      {
        category: "Permission Boundaries",
        items: [
          "Elevated tools disabled (elevated.enabled = false)",
          "Sandbox mode = 'require' for isolated cron builds",
          "Tool allowlist includes: read, write, edit, web_search",
          "Tool denylist includes: exec, shell, code (no runtime execution)",
        ],
      },
      {
        category: "Cost Controls",
        items: [
          "Max 3 retries per task (Rule 1)",
          "25K token halt rule enforced (Rule 5)",
          "No autonomous recursive sub-agent spawning (Rule 4)",
        ],
      },
      {
        category: "Escalation Paths",
        items: [
          "Escalation format documented (ESCALATE: severity | summary | action: | ref:)",
          "Warren session ID (agent:warren:main) in MEMORY.md",
          "Failures escalate to Nexus within 1 hour",
        ],
      },
    ],
  },
  research: {
    agent_type: "research",
    checklist: [
      {
        category: "Identity & Charter",
        items: [
          "Ring 2 or Ring 3 (research agents are specialised)",
          "SOUL.md documents research scope and output format",
          "No direct access to production systems",
        ],
      },
      {
        category: "Permission Boundaries",
        items: [
          "Elevated tools disabled",
          "Web access tools enabled (web_fetch, web_search)",
          "No write access to other agent workspaces",
        ],
      },
      {
        category: "Cost Controls",
        items: [
          "Max 3 retries per research query",
          "Token budget per session documented",
          "No recursive sub-agent spawning",
        ],
      },
      {
        category: "Data Handling",
        items: [
          "Research output stored in workspace only",
          "No PII in research logs",
          "Source attribution required for all findings",
        ],
      },
    ],
  },
  "customer-facing": {
    agent_type: "customer-facing",
    checklist: [
      {
        category: "Identity & Charter",
        items: [
          "Ring 3 (customer-facing agents have no privileged access)",
          "SOUL.md includes customer interaction guidelines",
          "Explicit rule: never share internal system details",
        ],
      },
      {
        category: "Permission Boundaries",
        items: [
          "No filesystem write access",
          "No access to other agent workspaces",
          "Elevated tools strictly disabled",
          "Tool allowlist limited to read-only + response generation",
        ],
      },
      {
        category: "Data Handling",
        items: [
          "No customer PII stored in workspace",
          "Response content filtered for internal references",
          "Interaction logs retained per compliance policy",
        ],
      },
      {
        category: "Escalation Paths",
        items: [
          "Escalation to human operator within 1 interaction for edge cases",
          "Warren notified on policy violation detection",
          "All escalations logged with timestamp",
        ],
      },
    ],
  },
  audit: {
    agent_type: "audit",
    checklist: [
      {
        category: "Identity & Charter",
        items: [
          "Ring 0 ONLY (audit agents require highest privilege)",
          "SOUL.md documents audit scope and reporting format",
          "Direct escalation to Rich via Telegram",
        ],
      },
      {
        category: "Permission Boundaries",
        items: [
          "Read access to all agent workspaces",
          "Write access limited to own workspace and audit logs",
          "Session history access enabled",
          "Sandbox mode = 'inherit' for system-wide visibility",
        ],
      },
      {
        category: "Audit Trail",
        items: [
          "All audit findings logged with timestamps",
          "Daily audit summary generated",
          "COR ledger maintained for binding corrections",
          "Governance runsheet referenced (warren-governance-report.md v2.1)",
        ],
      },
      {
        category: "Cost Controls",
        items: [
          "Thinking = 'low' for cost-efficient audit passes",
          "Cache retention = 'long' for multi-session audit continuity",
          "25K token halt rule enforced",
        ],
      },
    ],
  },
  coordination: {
    agent_type: "coordination",
    checklist: [
      {
        category: "Identity & Charter",
        items: [
          "Ring 0 or Ring 1 (Nexus is Ring 0)",
          "SOUL.md documents coordination protocols",
          "A2A routing enabled (agentToAgent.enabled = true)",
        ],
      },
      {
        category: "Permission Boundaries",
        items: [
          "Message tool enabled for cross-agent communication",
          "Session list/history access for monitoring",
          "No direct write to other agent workspaces",
          "Elevated tools disabled unless explicitly required",
        ],
      },
      {
        category: "Escalation Paths",
        items: [
          "Can route to any agent via A2A",
          "Warren is primary escalation target for governance",
          "Rich is final escalation for unresolved critical issues",
          "Heartbeat monitoring for all coordinated agents",
        ],
      },
      {
        category: "Runtime Guardrails",
        items: [
          "Coordination sessions have max execution time",
          "Cron schedules documented and versioned",
          "No runaway coordination loops",
        ],
      },
    ],
  },
};

function getGovernanceChecklist(agentType: string) {
  const cl = checklists[agentType];
  if (!cl) {
    return {
      error: `Unknown agent type: ${agentType}. Valid: build, research, customer-facing, audit, coordination`,
    };
  }
  return cl;
}

// ━━━ MCP Server ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export const server = new Server(
  { name: "scanner-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "scan_agent_config",
      description:
        "Scan a single agent configuration against 67 governance rules across 10 categories. Returns scored report with letter grade, findings, and recommendations.",
      inputSchema: {
        type: "object" as const,
        properties: {
          agent_config: {
            type: "object",
            description:
              "Agent configuration JSON (name, ring, workspace, model config, tools, elevated, agentToAgent, etc.)",
          },
        },
        required: ["agent_config"],
      },
    },
    {
      name: "scan_multi_agent_system",
      description:
        "Scan multiple agent configs plus orchestration config. Returns per-agent reports and cross-agent risk analysis (5 rules: XA-1 to XA-5).",
      inputSchema: {
        type: "object" as const,
        properties: {
          agents: {
            type: "array",
            items: { type: "object" },
            description: "Array of agent config objects",
          },
          orchestration: {
            type: "object",
            description:
              "Optional system-level orchestration config (cron jobs, A2A routing)",
          },
        },
        required: ["agents"],
      },
    },
    {
      name: "get_governance_checklist",
      description:
        "Get best-practice governance checklist for agent type: build, research, customer-facing, audit, or coordination.",
      inputSchema: {
        type: "object" as const,
        properties: {
          agent_type: {
            type: "string",
            enum: [
              "build",
              "research",
              "customer-facing",
              "audit",
              "coordination",
            ],
            description: "Type of agent to get checklist for",
          },
        },
        required: ["agent_type"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "scan_agent_config": {
        if (!args?.agent_config || typeof args.agent_config !== "object") {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error:
                    "Invalid input: agent_config must be a JSON object with at minimum a 'name' field",
                }),
              },
            ],
            isError: true,
          };
        }
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(scanAgentConfig(args.agent_config), null, 2),
            },
          ],
        };
      }

      case "scan_multi_agent_system": {
        if (
          !args?.agents ||
          !Array.isArray(args.agents) ||
          args.agents.length === 0
        ) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: "Invalid input: agents must be a non-empty array",
                }),
              },
            ],
            isError: true,
          };
        }
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                scanMultiAgentSystem(
                  args.agents as any[],
                  args.orchestration
                ),
                null,
                2
              ),
            },
          ],
        };
      }

      case "get_governance_checklist": {
        if (!args?.agent_type || typeof args.agent_type !== "string") {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error:
                    "Invalid input: agent_type must be one of: build, research, customer-facing, audit, coordination",
                }),
              },
            ],
            isError: true,
          };
        }
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                getGovernanceChecklist(args.agent_type as string),
                null,
                2
              ),
            },
          ],
        };
      }

      default:
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: `Unknown tool: ${name}` }),
            },
          ],
          isError: true,
        };
    }
  } catch (err: any) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            error: err.message || "Internal server error",
          }),
        },
      ],
      isError: true,
    };
  }
});

// ━━━ Start ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export async function main() {
  const port = process.argv.includes("--http") ? (process.env.PORT || "3000") : null;

  if (port) {
    // HTTP mode for mcpize dev / mcpize deploy
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
    });
    await server.connect(transport);

    const httpServer = http.createServer((req, res) => {
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, mcp-session-id",
        });
        res.end();
        return;
      }
      const url = new URL(req.url || "/", `http://localhost:${port}`);
      // Health check for mcpize dev
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", name: "scanner-mcp", version: "1.0.0" }));
        return;
      }
      if (url.pathname === "/mcp" || url.pathname === "/") {
        transport.handleRequest(req, res);
      } else {
        res.writeHead(404);
        res.end("Not found");
      }
    });

    httpServer.listen(parseInt(port as string), "0.0.0.0", () => {
      console.error(`Scanner MCP server running on http://0.0.0.0:${port}/mcp`);
    });
  } else {
    // Stdio mode for local MCP clients
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Scanner MCP server running on stdio");
  }
}

// Only auto-start when run directly (not when imported by worker.ts)
const isDirectRun = process.argv[1]?.endsWith("index.js") || process.argv[1]?.endsWith("index.ts");
if (isDirectRun) {
  main().catch(console.error);
}
