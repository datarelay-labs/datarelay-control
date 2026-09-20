#!/usr/bin/env bash

ROOT="${1:-$PWD}"

CONSTITUTION="$ROOT/.specify/memory/constitution.md"
SPECS_INDEX="$ROOT/.specify/specs-index.md"
MASTER_DESIGN="$ROOT/docs/master-design.md"

POLICY='
## Language Policy

All project code, UI screens, labels, menus, buttons, placeholders, validation messages, API responses, logs, comments, documentation strings, seed/mock data, and Skill Spec content MUST be written in English only.

Korean or other non-English text is allowed only in external user communication, temporary Cursor prompts, or archived conversation notes. It MUST NOT be committed into product code, runtime UI, API schema, database seed data, tests, screenshots, or official project specifications.

Any new feature, refactor, UI change, or test must verify that user-facing and developer-facing product text remains English-only.
'

append_once() {
  local file="$1"
  local title="$2"

  if [ ! -f "$file" ]; then
    echo "SKIP: not found: $file"
    return 0
  fi

  if grep -q "All project code, UI screens, labels" "$file"; then
    echo "OK: already exists: $file"
    return 0
  fi

  {
    echo ""
    echo "$title"
    echo "$POLICY"
  } >> "$file"

  echo "UPDATED: $file"
}

echo "ROOT=$ROOT"
append_once "$CONSTITUTION" "# English-Only Product Language Policy"
append_once "$SPECS_INDEX" "# English-Only Product Language Policy"
append_once "$MASTER_DESIGN" "# English-Only Product Language Policy"

echo ""
echo "Done."
echo "Verify:"
echo "grep -Rni \"English-Only Product Language Policy\\|All project code, UI screens\" \"$ROOT/.specify\" \"$ROOT/docs\""

read -p "Press Enter to close..."
