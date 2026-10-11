/**
 * NEXPLAN as an MCP server: every agent tool (src/agent/) as an MCP tool, the conventions as a resource. One
 * Workspace per server, so the structures a client loads stay loaded for its session. main.ts runs it on stdio.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import conventions from "../../docs/CONVENTIONS.md?raw";
import { NEXPLAN_INSTRUCTIONS, NEXPLAN_TOOLS, runTool, toJson, Workspace } from "../agent/index.ts";
import { APP_VERSION } from "../app/version.ts";

export function createServer(workspace = new Workspace()): McpServer {
  const server = new McpServer({ name: "nexplan", title: "NEXPLAN", version: APP_VERSION }, { instructions: NEXPLAN_INSTRUCTIONS });
  for (const tool of NEXPLAN_TOOLS) {
    server.registerTool(tool.name, { title: tool.title, description: tool.description, inputSchema: tool.input, annotations: { title: tool.title, ...tool.annotations } }, async (args, extra) => {
      const r = await runTool(tool, args, { workspace, signal: extra.signal });
      if (r.ok) return { content: [{ type: "text", text: toJson(r.value) }] };
      return { content: [{ type: "text", text: r.details ? `${r.error}\n${toJson(r.details)}` : r.error }], isError: true };
    });
  }
  server.registerResource(
    "conventions",
    "nexplan://docs/conventions",
    { title: "NEXPLAN conventions", description: "The formulas NEXPLAN uses, their units and literature sources, and the corrections of the 2026-10-06 review.", mimeType: "text/markdown" },
    (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: conventions }] }),
  );
  return server;
}
