/** Runs the NEXPLAN MCP server on stdio (built to dist-mcp/nexplan-mcp.mjs by vite.mcp.config.ts). Logs go to stderr: stdout carries the protocol. */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { APP_VERSION } from "../app/version.ts";
import { createServer } from "./server.ts";

await createServer().connect(new StdioServerTransport());
console.error(`NEXPLAN ${APP_VERSION} MCP server on stdio`);
