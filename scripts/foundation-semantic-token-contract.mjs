const SEMANTIC_TOKEN_PATTERN = /--dr-[a-z0-9-]+(?=\s*:)/g;

export function discoverSemanticTokenNames(css) {
  return [...new Set(css.match(SEMANTIC_TOKEN_PATTERN) ?? [])];
}

export function requireSemanticTokenNames(css) {
  const names = discoverSemanticTokenNames(css);
  if (names.length === 0) {
    throw new Error("foundation-semantic-token-discovery-empty");
  }
  return names;
}
