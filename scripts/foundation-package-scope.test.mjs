import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  FOUNDATION_PACKAGE_SCOPE,
  FOUNDATION_REGISTRY_URL,
  FOUNDATION_TOKENS_ENTRY,
  FOUNDATION_TOKENS_PACKAGE
} from "./foundation-package-scope.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const expectedNpmrc = `${FOUNDATION_PACKAGE_SCOPE}:registry=${FOUNDATION_REGISTRY_URL}\n`;

test("uses the repository-owned Foundation package namespace", () => {
  assert.equal(FOUNDATION_PACKAGE_SCOPE, "@datarelay-labs");
  assert.equal(FOUNDATION_TOKENS_ENTRY, "@datarelay-labs/foundation/tokens");
  assert.equal(FOUNDATION_TOKENS_PACKAGE, "@datarelay-labs/tokens");
});

test("maps Foundation scope to GitHub Packages without committed credentials", () => {
  for (const file of [".npmrc", "frontend/.npmrc"]) {
    const content = fs.readFileSync(path.join(root, file), "utf8");
    assert.equal(content, expectedNpmrc);
    assert.doesNotMatch(content, /(?:_authToken|password|token)\s*=/i);
  }
});
