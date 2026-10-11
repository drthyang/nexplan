import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NEXPLAN_TOOLS } from "../agent/index.ts";
import { createServer } from "./server.ts";

const client = new Client({ name: "test", version: "0" });
const text = (r: Awaited<ReturnType<typeof client.callTool>>) => (r.content as { type: string; text: string }[])[0]!.text;

beforeAll(async () => {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer().connect(a);
  await client.connect(b);
});
afterAll(() => client.close());

describe("the MCP server", () => {
  it("introduces itself with instructions", () => {
    expect(client.getServerVersion()).toMatchObject({ name: "nexplan" });
    expect(client.getInstructions()).toMatch(/load_structure/);
  });

  it("lists every agent tool with its JSON Schema and annotations", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(NEXPLAN_TOOLS.map((t) => t.name));
    const info = tools.find((t) => t.name === "reflection_info")!;
    expect(info.inputSchema.required).toEqual(["structure_id", "hkl"]);
    expect(info.annotations).toMatchObject({ readOnlyHint: true });
  });

  it("keeps a structure loaded across calls, and returns JSON", async () => {
    const loaded = JSON.parse(text(await client.callTool({ name: "load_structure", arguments: { bundled: "nacl" } })));
    expect(loaded.structure_id).toBe("nacl");
    const r = await client.callTool({ name: "reflection_info", arguments: { structure_id: "nacl", hkl: [2, 0, 0] } });
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(text(r)).status).toBe("present");
  });

  it("reports failures as tool errors the model can read", async () => {
    const r = await client.callTool({ name: "list_reflections", arguments: { structure_id: "missing" } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/No structure 'missing'/);
    const bad = await client.callTool({ name: "reflection_info", arguments: { structure_id: "nacl", hkl: "2 0 0" } });
    expect(bad.isError).toBe(true);
  });

  it("serves the conventions as a resource", async () => {
    const r = await client.readResource({ uri: "nexplan://docs/conventions" });
    expect((r.contents[0] as { text: string }).text).toMatch(/^# /);
  });
});
