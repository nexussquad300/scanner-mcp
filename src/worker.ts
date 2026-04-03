/**
 * Cloudflare Workers entry point for ScannerMCP.
 * Stateless per-request pattern — new transport per request.
 */
import { createServer } from "./index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

function corsHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, mcp-session-id, Accept",
    ...extra,
  };
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Health check
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      return new Response(
        JSON.stringify({ status: "ok", name: "scanner-mcp", version: "1.0.0" }),
        { headers: { ...corsHeaders(), "Content-Type": "application/json" } }
      );
    }

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // Smithery server card
    if (request.method === "GET" && url.pathname === "/.well-known/mcp/server-card.json") {
      return new Response(
        JSON.stringify({
          name: "scanner-mcp",
          description: "Agent Governance Scanner — Deterministic governance scanning for AI agent configurations. 51 rules across 10 categories.",
          version: "1.0.0",
          tools: [
            { name: "governance_scan", description: "Run a full governance scan against an agent configuration" },
            { name: "governance_categories", description: "List all governance scan categories and rule counts" },
            { name: "governance_rules", description: "List all governance rules with details" }
          ],
          connection: {
            type: "streamable-http",
            url: "https://scanner-mcp.nexus300.workers.dev/mcp"
          }
        }),
        { headers: { ...corsHeaders(), "Content-Type": "application/json" } }
      );
    }

    // MCP endpoint
    if (url.pathname === "/mcp" || url.pathname === "/") {
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined as any,
        enableJsonResponse: true,
      });

      const server = createServer();
      await server.connect(transport);

      // Ensure Accept header (Smithery scanner fix)
      const headers = new Headers(request.headers);
      if (!headers.get("Accept")?.includes("text/event-stream")) {
        headers.set("Accept", "application/json, text/event-stream");
      }
      const patchedRequest = new Request(request.url, {
        method: request.method,
        headers,
        body: request.body,
        duplex: "half",
      } as any);

      const response = await transport.handleRequest(patchedRequest);
      const newHeaders = new Headers(response.headers);
      for (const [k, v] of Object.entries(corsHeaders())) newHeaders.set(k, v);
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: newHeaders,
      });
    }

    return new Response("Not found", { status: 404 });
  },
};
