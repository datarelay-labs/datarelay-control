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
const expectedRootNpmrc = `${FOUNDATION_PACKAGE_SCOPE}:registry=${FOUNDATION_REGISTRY_URL}\n`;
const expectedFrontendNpmrc = `${FOUNDATION_PACKAGE_SCOPE}:registry=${FOUNDATION_REGISTRY_URL}\n//npm.pkg.github.com/:_authToken=\${NODE_AUTH_TOKEN}\nalways-auth=true\n`;

test("uses the repository-owned Foundation package namespace", () => {
  assert.equal(FOUNDATION_PACKAGE_SCOPE, "@datarelay-labs");
  assert.equal(FOUNDATION_TOKENS_ENTRY, "@datarelay-labs/foundation/tokens");
  assert.equal(FOUNDATION_TOKENS_PACKAGE, "@datarelay-labs/tokens");
});

test("maps Foundation scope to GitHub Packages without committed credentials", () => {
  const rootContent = fs.readFileSync(path.join(root, ".npmrc"), "utf8");
  const frontendContent = fs.readFileSync(path.join(root, "frontend/.npmrc"), "utf8");
  assert.equal(rootContent, expectedRootNpmrc);
  assert.equal(frontendContent, expectedFrontendNpmrc);
  assert.doesNotMatch(rootContent, /ghp_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+/);
  assert.doesNotMatch(frontendContent, /ghp_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+/);
});
