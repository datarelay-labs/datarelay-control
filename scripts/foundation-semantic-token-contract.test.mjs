import assert from "node:assert/strict";
import test from "node:test";

import {
  discoverSemanticTokenNames,
  requireSemanticTokenNames,
} from "./foundation-semantic-token-contract.mjs";

test("discovers unique Foundation semantic token names", () => {
  assert.deepEqual(
    discoverSemanticTokenNames(":root { --dr-text-primary: red; --dr-text-primary: blue; --dr-space-2: 8px; }"),
    ["--dr-text-primary", "--dr-space-2"],
  );
});

test("fails closed when the Foundation semantic token contract is empty", () => {
  assert.throws(
    () => requireSemanticTokenNames("/* empty or incompatible generated token artifact */"),
    /foundation-semantic-token-discovery-empty/,
  );
});
