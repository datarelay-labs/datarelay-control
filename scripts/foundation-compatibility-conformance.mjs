import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requireSemanticTokenNames } from "./foundation-semantic-token-contract.mjs";
import { FOUNDATION_TOKENS_ENTRY, FOUNDATION_TOKENS_PACKAGE } from "./foundation-package-scope.mjs";

function fail(reason) {
  console.error(`CONTROL_FOUNDATION_CONFORMANCE=FAIL REASON=${reason}`);
  process.exit(2);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const foundationRoot = process.env.DATARELAY_FOUNDATION_ROOT;
const expectedVersion = process.env.DATARELAY_FOUNDATION_VERSION;
if (!foundationRoot) fail("foundation-root-missing");
if (!expectedVersion) fail("foundation-version-missing");

const manifest = JSON.parse(fs.readFileSync(path.join(root, "foundation.manifest.json"), "utf8"));
if (manifest?.contract_version !== 1 || manifest?.product?.id !== "control") fail("manifest-identity");
if (manifest.product.home_route !== "/monitoring") fail("manifest-home-route");
if (!Array.isArray(manifest.navigation) || manifest.navigation.length !== 0) fail("initial-slice-navigation-must-remain-product-owned");
if (!Array.isArray(manifest.capabilities) || manifest.capabilities.length !== 0) fail("initial-slice-capabilities-must-remain-product-owned");

let resolved;
try {
  resolved = import.meta.resolve(FOUNDATION_TOKENS_ENTRY);
} catch (error) {
  fail(`umbrella-sdk-unavailable:${error instanceof Error ? error.message : String(error)}`);
}
const resolvedFile = fileURLToPath(resolved);
const foundationPackageRoot = path.resolve(path.dirname(resolvedFile), "..");
const installedManifest = JSON.parse(fs.readFileSync(path.join(foundationPackageRoot, "package.json"), "utf8"));
if (installedManifest.version !== expectedVersion) fail(`umbrella-version:${installedManifest.version}`);
const umbrellaTokenSource = fs.readFileSync(resolvedFile, "utf8");
if (!umbrellaTokenSource.includes(`export * from "${FOUNDATION_TOKENS_PACKAGE}"`)) fail("umbrella-token-export");
const tokenPackageRoot = path.resolve(foundationPackageRoot, "..", "tokens");
const installedTokenManifest = JSON.parse(fs.readFileSync(path.join(tokenPackageRoot, "package.json"), "utf8"));
if (installedTokenManifest.version !== expectedVersion) fail(`tokens-version:${installedTokenManifest.version}`);
const generatedTokenSource = fs.readFileSync(path.join(tokenPackageRoot, "src/generated.ts"), "utf8");
if (!generatedTokenSource.includes("export const dataRelayTokens")) fail("tokens-generated-export");

const candidateCss = fs.readFileSync(path.join(foundationRoot, "packages/tokens/src/generated.css"), "utf8");
const controlCss = fs.readFileSync(path.join(root, "frontend/src/foundation-semantic-tokens.css"), "utf8");
let expectedNames;
try {
  expectedNames = requireSemanticTokenNames(candidateCss);
} catch (error) {
  fail(error instanceof Error ? error.message : "foundation-semantic-token-discovery");
}
const actualNames = new Set(controlCss.match(/--dr-[a-z0-9-]+(?=\s*:)/g) ?? []);
const missing = expectedNames.filter((name) => !actualNames.has(name));
if (missing.length) fail(`semantic-token-missing:${missing.join(",")}`);

console.log(`CONTROL_FOUNDATION_CONFORMANCE=PASS TOKENS=${expectedNames.length}`);
console.log(`FOUNDATION_VERSION=${expectedVersion}`);
console.log(`FOUNDATION_REVISION=${process.env.DATARELAY_FOUNDATION_REVISION ?? "unknown"}`);
console.log("CONTROL_AUTHORITY_BOUNDARY=UNCHANGED");
