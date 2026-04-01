/**
 * Cloudflare Workers entry point for ScannerMCP.
 * Thin wrapper — all tool logic lives in index.ts.
 */
import { server } from "./index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

const transport = new WebStandardStreamableHTTPServerTransport({
  sessionIdGenerator: () => crypto.randomUUID(),
  enableJsonResponse: true,
});

await server.connect(transport);

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

    // MCP endpoint
    if (url.pathname === "/mcp" || url.pathname === "/") {
      const response = await transport.handleRequest(request);
      // Add CORS headers to MCP responses
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
