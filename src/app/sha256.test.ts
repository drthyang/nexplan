import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sha256Bytes, sha256Hex } from "./sha256.ts";

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const node = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const ours = (s: string) => hex(sha256Bytes(new TextEncoder().encode(s)));

describe("sha256 fallback for non-secure origins", () => {
  it("matches the FIPS 180-2 examples", () => {
    expect(ours("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(ours("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).toBe("248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
    expect(ours("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("matches node:crypto at every padding boundary, for non-ASCII text and a real CIF", () => {
    for (let n = 0; n <= 200; n++) expect(ours("x".repeat(n))).toBe(node("x".repeat(n)));
    expect(ours("Mg₈Al₁₆O₃₂ · Å · λ")).toBe(node("Mg₈Al₁₆O₃₂ · Å · λ"));
    const cif = readFileSync(new URL("../../fixtures/cif/cod-9001364.cif", import.meta.url), "utf8");
    expect(ours(cif)).toBe(node(cif));
  });

  it("gives the same hex whether or not crypto.subtle is available", async () => {
    const saved = Object.getOwnPropertyDescriptor(globalThis, "crypto")!;
    const withSubtle = await sha256Hex("NEXPLAN");
    Object.defineProperty(globalThis, "crypto", { value: {}, configurable: true });
    try {
      expect(await sha256Hex("NEXPLAN")).toBe(withSubtle);
    } finally {
      Object.defineProperty(globalThis, "crypto", saved);
    }
    expect(withSubtle).toBe(node("NEXPLAN"));
  });
});
