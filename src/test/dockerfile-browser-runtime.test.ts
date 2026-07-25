import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "..", "..");

test("runtime image installs and selects a native Chromium browser", async () => {
  const dockerfile = await readFile(path.join(REPO_ROOT, "Dockerfile"), "utf8");

  assert.match(dockerfile, /\bchromium\b/);
  assert.match(dockerfile, /PLAYWRIGHT_EXECUTABLE_PATH=\/usr\/bin\/chromium/);
  assert.match(dockerfile, /ARTIFACT_BROWSER_PATH=\/usr\/bin\/chromium/);
  assert.match(dockerfile, /CHROME_BIN=\/usr\/bin\/chromium/);
  assert.match(dockerfile, /ldd \/usr\/lib\/chromium\/chromium/);
  assert.match(dockerfile, /grep -q "not found"/);
});
