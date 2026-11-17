import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-remote-catalog-"));
process.env.DATA_DIR = dir;
const { GET } = await import("../../src/app/api/v1/models/route.ts");
const { resetDbInstance } = await import("../../src/lib/db/core.ts");
test.after(() => {
  resetDbInstance();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("explicit Codex catalog requires the requesting client version", async () => {
  const response = await GET(new Request("http://localhost/v1/models?format=codex"));
  assert.equal(response.status, 400);
});
