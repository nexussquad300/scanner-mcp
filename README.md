# ScannerMCP — Agent Infrastructure Governance Scanner

Deterministic governance scanner for multi-agent systems. Evaluates agent configurations against 51 rules across 10 categories — no LLM calls, no inference, just JSON/string inspection. Returns scored reports with letter grades, per-category breakdowns, findings, and recommendations.

## Tools

| Tool | Purpose |
|------|---------|
| `scan_agent_config` | Scan one agent config against all governance rules |
| `scan_multi_agent_system` | Scan multiple agents + cross-agent risk analysis (5 rules) |
| `get_governance_checklist` | Static best-practice checklist by agent type |

## Example Input

```json
{
  "agent_config": {
    "name": "forge",
    "ring": "Ring 1",
    "workspace": "/path/to/forge",
    "agents": {
      "defaults": {
        "model": {
          "primary": "anthropic/claude-sonnet-4-5-20250929"
        },
        "models": {
          "anthropic/claude-sonnet-4-5-20250929": {
            "params": {
              "cacheRetention": "long",
              "thinking": "low"
            }
          }
        }
      }
    },
    "elevated": { "enabled": false },
    "agentToAgent": { "enabled": true },
    "tools": { "deny": ["group:runtime", "group:ui"] },
    "sandbox": "inherit"
  }
}
```

For agents without filesystem access (remote scans), pass file contents via `workspace_files`:

```json
{
  "agent_config": {
    "name": "forge",
    "ring": "Ring 1",
    "workspace_files": {
      "SOUL.md": "# Forge\n## CORE PURPOSE\nTechnical architect...\n## AUTHORITY\n...",
      "MEMORY.md": "# Memory\n## Governance Version v1.1\n..."
    }
  }
}
```

## Example Output

```json
{
  "agent_name": "warren",
  "scan_timestamp": "2026-04-01T12:42:00.000Z",
  "overall_score": 75,
  "letter_grade": "B",
  "status": "HEALTHY",
  "categories": [
    {
      "category_id": 1,
      "category_name": "Identity & Charter",
      "score": 10,
      "max_score": 10,
      "status": "PASS",
      "findings": [],
      "recommendations": [],
      "passed_rules": ["1.1", "1.2", "1.3", "1.4", "1.5"],
      "failed_rules": []
    },
    {
      "category_id": 4,
      "category_name": "Cost Controls",
      "score": 4,
      "max_score": 10,
      "status": "WARN",
      "findings": [
        "Cost governance rules not referenced in agent memory",
        "Max retries rule not documented",
        "25K token halt rule not documented",
        "No explicit prohibition on recursive sub-agent spawning"
      ],
      "recommendations": [
        "Add COR-COST-001 reference to agent MEMORY.md",
        "Add Rule 1 (max 3 retries per task) to SOUL.md",
        "Add Rule 5 (25K token halt) to SOUL.md",
        "Add Rule 4 (no autonomous recursive fixing) to SOUL.md"
      ],
      "passed_rules": ["4.4"],
      "failed_rules": ["4.1", "4.2", "4.3", "4.5"]
    }
  ],
  "summary": {
    "total_rules_evaluated": 51,
    "total_rules_passed": 36,
    "total_rules_failed": 15,
    "critical_violations": 1,
    "high_severity_violations": 8
  }
}
```

## Scoring

| Grade | Score | Status |
|-------|-------|--------|
| A | 85-100 | HEALTHY |
| B | 70-84 | HEALTHY |
| C | 55-69 | DEGRADED |
| D | 40-54 | DEGRADED |
| F | 0-39 | FAILING |

Per-category: PASS (>=70%), WARN (40-69%), FAIL (<40%)

## Categories (10)

1. Identity & Charter
2. Model Assignment
3. Permission Boundaries
4. Cost Controls
5. Escalation Paths
6. Audit Trail
7. Data Handling
8. Failure Modes
9. Runtime Guardrails
10. Governance Documentation

## Pricing

| Tier | Limit | Price |
|------|-------|-------|
| Free | 3 scans | $0 |
| Single agent scan | per call | $0.05 |
| Multi-agent scan | per call | $0.15 |

## Install & Usage

### As MCP server (stdio — for Claude Code, Cursor, etc.)

```bash
cd scanner-mcp
npm install && npm run build
```

Add to your MCP client config:

```json
{
  "mcpServers": {
    "scanner-mcp": {
      "command": "node",
      "args": ["/path/to/scanner-mcp/build/index.js"]
    }
  }
}
```

### As HTTP server (for MCPize / remote access)

```bash
PORT=3000 node build/index.js
# MCP endpoint: POST http://localhost:3000/mcp
# Health check: GET http://localhost:3000/health
```

### Deploy to MCPize

```bash
npm install -g mcpize
mcpize login
mcpize deploy
```

## Dogfood Results (OpenClaw agents, 2026-04-01)

| Agent | Score | Grade | Status |
|-------|-------|-------|--------|
| Warren (Ring 0, audit) | 75/100 | B | HEALTHY |
| Smith (Ring 1, build) | 65/100 | C | DEGRADED |
| Vale (Ring 0, audit) | 59/100 | C | DEGRADED |

## Source

Rules: Warren (Ring 0, Systems Audit) — `governance_scan_rules_v1.json`
Spec: Forge (Technical Architect) — `SCANNERMCP_SPEC.md`
Build: Smith (Implementation Agent)
