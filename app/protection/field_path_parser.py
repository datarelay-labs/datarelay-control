"""Concrete Protection-field path grammar (not a general JSONPath query engine).

Protection rules target definite object members, array indexes and historical
schema "[]" wildcards. Decode RFC 9535 quoted member-name escapes without
requiring jsonpath-ng to preserve them. Do not treat malformed paths as root.
"""
from __future__ import annotations

import re

_HEX = frozenset("0123456789abcdefABCDEF")
_SIMPLE_ESCAPES = {
    "\\": "\\",
    "'": "'",
    '"': '"',
    "/": "/",
    "b": "\b",
    "f": "\f",
    "n": "\n",
    "r": "\r",
    "t": "\t",
}
_INTEGER_INDEX = re.compile(r"-?(?:0|[1-9][0-9]*)$")
_BARE_LEGACY_KEY = re.compile(r"[A-Za-z_][A-Za-z0-9_]*$")


def _unicode_escape(path: str, index: int) -> tuple[int, int]:
    """Decode one RFC hex escape at the 'u' location, returning codepoint/next."""
    digits = path[index + 1 : index + 5]
    if len(digits) != 4 or any(ch not in _HEX for ch in digits):
        raise ValueError("Invalid Unicode escape in Protection field path")
    codepoint = int(digits, 16)
    return codepoint, index + 5


def _read_quoted_key(path: str, start: int) -> tuple[str, int]:
    quote = path[start]
    assert quote in ("'", '"')
    i = start + 1
    value: list[str] = []
    while i < len(path):
        c = path[i]
        if c == quote:
            field = "".join(value)
            # Distinguish the internal historical array wildcard "[]" from a
            # literal member bearing that exact name, rather than misapplying
            # protection to an unrelated list. A typed path version is needed.
            if field == "[]":
                raise ValueError("Ambiguous literal '[]' member requires a versioned path")
            return field, i + 1
        if c != "\\":
            if ord(c) < 32:
                raise ValueError("Unescaped control character in Protection field path")
            value.append(c)
            i += 1
            continue
        i += 1
        if i >= len(path):
            raise ValueError("Unterminated escape in Protection field path")
        esc = path[i]
        if esc in _SIMPLE_ESCAPES:
            value.append(_SIMPLE_ESCAPES[esc])
            i += 1
            continue
        if esc != "u":
            raise ValueError("Unsupported escape in Protection field path")
        cp, i = _unicode_escape(path, i)
        if 0xD800 <= cp <= 0xDBFF:
            # A high surrogate MUST be followed by a low surrogate pair.
            if path[i : i + 2] != "\\u":
                raise ValueError("Missing low surrogate in Protection field path")
            low, i = _unicode_escape(path, i + 1)
            if not 0xDC00 <= low <= 0xDFFF:
                raise ValueError("Invalid low surrogate in Protection field path")
            cp = 0x10000 + ((cp - 0xD800) << 10) + (low - 0xDC00)
        elif 0xDC00 <= cp <= 0xDFFF:
            raise ValueError("Unpaired low surrogate in Protection field path")
        value.append(chr(cp))
    raise ValueError("Unterminated quoted member in Protection field path")


def parse_protection_path(path: str) -> list[str | int]:
    """Parse definite Protection path tokens and internal historical wildcards.

    Accepted: $.field, $['literal.dot'], $.items[].secret, $.items[*].secret,
    $.items[-1].secret, and legacy bare path names. Expressions that could
    select multiple unrelated paths, filters, or recursive descent are rejected.
    """
    text = str(path).strip()
    if not text:
        return []
    if not text.startswith("$"):
        text = "$." + text
    if text == "$":
        return []
    tokens: list[str | int] = []
    i = 1
    while i < len(text):
        marker = text[i]
        if marker == ".":
            i += 1
            begin = i
            while i < len(text) and text[i] not in ".[":
                i += 1
            name = text[begin:i]
            if not name or "]" in name:
                raise ValueError("Invalid dot-notation Protection field path")
            tokens.append(name)
            continue
        if marker != "[":
            raise ValueError("Invalid Protection field path selector")

        if text.startswith("[]", i):
            tokens.append("[]")
            i += 2
            continue
        if text.startswith("[*]", i):
            tokens.append("[]")
            i += 3
            continue
        # Keep existing jsonpath-ng support for the unlimited slice shorthand.
        if text.startswith("[:]", i):
            tokens.append("[]")
            i += 3
            continue
        if text.startswith("[::]", i):
            tokens.append("[]")
            i += 4
            continue
        if i + 1 < len(text) and text[i + 1] in ("'", '"'):
            member, end = _read_quoted_key(text, i + 1)
            if end >= len(text) or text[end] != "]":
                raise ValueError("Missing bracket after quoted Protection member")
            tokens.append(member)
            i = end + 1
            continue

        close = text.find("]", i + 1)
        if close < 0:
            raise ValueError("Unclosed bracket in Protection field path")
        token = text[i + 1 : close]
        if _INTEGER_INDEX.fullmatch(token):
            tokens.append(int(token))
        elif _BARE_LEGACY_KEY.fullmatch(token):
            tokens.append(token)
        else:
            raise ValueError("Unsupported Protection path bracket selector")
        i = close + 1
    return tokens
