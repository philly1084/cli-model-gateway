#!/usr/bin/env node

import { readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

async function collectCompiledTests(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectCompiledTests(candidate));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".test.js")) {
      files.push(candidate);
    }
  }

  return files.sort((left, right) => left.localeCompare(right, "en"));
}

async function main() {
  const testRoot = path.resolve(process.cwd(), "dist", "test");
  const testFiles = await collectCompiledTests(testRoot);
  if (testFiles.length === 0) {
    throw new Error(`No compiled test files found under ${testRoot}`);
  }

  console.log(`Running ${testFiles.length} compiled test files.`);
  const testRunnerArgs = process.argv.slice(2);
  const result = spawnSync(process.execPath, ["--test", ...testRunnerArgs, ...testFiles], {
    stdio: "inherit",
    shell: false,
    windowsHide: true,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.signal) {
    throw new Error(`Compiled tests terminated by signal ${result.signal}`);
  }
  process.exitCode = result.status ?? 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
