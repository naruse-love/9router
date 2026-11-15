import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-conn-prio-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
});

afterEach(() => {
  try {
    global._dbAdapter?.instance?.close?.();
  } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("connectionsRepo.getProviderConnections priority sorting", () => {
  it("sorts priority 0 ahead of priority 1 and null/undefined last (matching orderFromCursor)", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const { createProviderConnection, getProviderConnections } = await import(
      "@/lib/db/repos/connectionsRepo.js"
    );

    const c1 = await createProviderConnection({
      provider: "gemini",
      authType: "apikey",
      name: "p1",
      apiKey: "k1",
    });
    const c2 = await createProviderConnection({
      provider: "gemini",
      authType: "apikey",
      name: "p0",
      apiKey: "k0",
    });
    const c3 = await createProviderConnection({
      provider: "gemini",
      authType: "apikey",
      name: "pNull",
      apiKey: "kNull",
    });

    const db = await getAdapter();
    db.run(`UPDATE providerConnections SET priority = 0 WHERE id = ?`, [c2.id]);
    db.run(`UPDATE providerConnections SET priority = NULL WHERE id = ?`, [c3.id]);

    const list = await getProviderConnections({ provider: "gemini", isActive: true });
    expect(list.map((c) => [c.name, c.priority])).toEqual([
      ["p0", 0],
      ["p1", 1],
      ["pNull", null],
    ]);
  });
});
