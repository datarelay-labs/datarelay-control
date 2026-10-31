"""Sandboxed calculated-expression evaluation (no eval/exec)."""

from __future__ import annotations

import re
from datetime import UTC, datetime
from typing import Any

from app.enrichers.field_paths import get_field_value

_FIELD_REF_RE = re.compile(r"\{\{\s*([^}]+?)\s*\}\}")
_IDENT_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_.]*$")


class ExpressionEvaluationError(Exception):
    """Invalid or unsupported calculated expression."""


def _coerce_str(value: Any) -> str:
    if value is None:
        return ""
    return str(value)


def _split_args(arg_blob: str) -> list[str]:
    args: list[str] = []
    depth = 0
    in_single = False
    in_double = False
    start = 0
    i = 0
    while i < len(arg_blob):
        ch = arg_blob[i]
        if ch == "'" and not in_double:
            in_single = not in_single
        elif ch == '"' and not in_single:
            in_double = not in_double
        elif not in_single and not in_double:
            if ch == "(":
                depth += 1
            elif ch == ")":
                depth -= 1
            elif ch == "," and depth == 0:
                args.append(arg_blob[start:i].strip())
                start = i + 1
        i += 1
    tail = arg_blob[start:].strip()
    if tail:
        args.append(tail)
    return args


def _parse_literal(token: str, event: dict[str, Any]) -> Any:
    t = token.strip()
    if not t:
        return ""
    if (t.startswith("'") and t.endswith("'")) or (t.startswith('"') and t.endswith('"')):
        return t[1:-1]
    if t.lower() in {"true", "false"}:
        return t.lower() == "true"
    if re.fullmatch(r"-?\d+", t):
        return int(t)
    if re.fullmatch(r"-?\d+\.\d+", t):
        return float(t)
    if _IDENT_RE.match(t):
        val = get_field_value(event, t)
        if val is not None:
            return val
        return event.get(t)
    raise ExpressionEvaluationError(f"Unsupported token {t!r}")


def _evaluate_function(name: str, arg_blob: str, event: dict[str, Any]) -> Any:
    fn = name.strip().lower()
    args = [_parse_literal(a, event) for a in _split_args(arg_blob)]
    if fn == "concat":
        return "".join(_coerce_str(a) for a in args)
    if fn == "upper":
        if len(args) != 1:
            raise ExpressionEvaluationError("upper() expects exactly one argument")
        return _coerce_str(args[0]).upper()
    if fn == "lower":
        if len(args) != 1:
            raise ExpressionEvaluationError("lower() expects exactly one argument")
        return _coerce_str(args[0]).lower()
    if fn == "coalesce":
        for arg in args:
            if arg is not None and _coerce_str(arg) != "":
                return arg
        return args[-1] if args else ""
    if fn == "now_utc":
        return datetime.now(UTC).isoformat().replace("+00:00", "Z")
    raise ExpressionEvaluationError(f"Unsupported function {name!r}")


def _substitute_field_refs(expression: str, event: dict[str, Any]) -> str:
    def repl(match: re.Match[str]) -> str:
        path = match.group(1).strip()
        val = get_field_value(event, path)
        if val is None:
            val = event.get(path)
        if isinstance(val, str):
            return repr(val)
        if val is None:
            return "''"
        return repr(str(val))

    return _FIELD_REF_RE.sub(repl, expression)


_FUNCTION_NAMES = ("concat", "upper", "lower", "coalesce", "now_utc")


def _replace_innermost_function(expr: str, event: dict[str, Any]) -> tuple[str, bool]:
    lower = expr.lower()
    for fn in _FUNCTION_NAMES:
        search_from = 0
        while True:
            idx = lower.find(f"{fn}(", search_from)
            if idx < 0:
                break
            name_end = idx + len(fn)
            open_paren = name_end
            depth = 1
            pos = open_paren + 1
            in_single = False
            in_double = False
            while pos < len(expr) and depth > 0:
                ch = expr[pos]
                if ch == "'" and not in_double:
                    in_single = not in_single
                elif ch == '"' and not in_single:
                    in_double = not in_double
                elif not in_single and not in_double:
                    if ch == "(":
                        depth += 1
                    elif ch == ")":
                        depth -= 1
                pos += 1
            if depth != 0:
                break
            arg_blob = expr[open_paren + 1 : pos - 1]
            if "(" in arg_blob:
                search_from = open_paren + 1
                continue
            result = _evaluate_function(fn, arg_blob, event)
            expr = expr[:idx] + repr(result) + expr[pos:]
            lower = expr.lower()
            return expr, True
    return expr, False


def _evaluate_function_expression(expression: str, event: dict[str, Any]) -> Any:
    expr = expression.strip()
    if not expr:
        raise ExpressionEvaluationError("Empty expression")
    for _ in range(64):
        expr, changed = _replace_innermost_function(expr, event)
        if not changed:
            break
    else:
        raise ExpressionEvaluationError("Expression too complex")
    return _parse_literal(expr, event)


# ---------------------------------------------------------------------------
# Operator expressions: comparisons, arithmetic, boolean logic, ternary and the
# known functions, parsed into a tiny AST and evaluated without eval/exec.
# ---------------------------------------------------------------------------

SUPPORTED_EXPRESSION_SYNTAX = (
    "field names, numbers, 'text', + - * / %, == != === !== > >= < <=, && ||, "
    "condition ? a : b, field.includes('x'), concat/upper/lower/coalesce/now_utc and {{ field }}"
)

_TOKEN_RE = re.compile(
    r"""\s*(?:
        (?P<num>\d+\.\d+|\d+)
      | (?P<str>'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")
      | (?P<ident>[A-Za-z_][A-Za-z0-9_.]*)
      | (?P<op>===|!==|==|!=|>=|<=|&&|\|\||[<>+\-*/%!?:(),])
    )""",
    re.VERBOSE,
)

_FUNCTION_ARITY: dict[str, tuple[int, int | None]] = {
    "concat": (0, None),
    "upper": (1, 1),
    "lower": (1, 1),
    "coalesce": (1, None),
    "now_utc": (0, 0),
}


def _tokenize(expression: str) -> list[tuple[str, str]]:
    tokens: list[tuple[str, str]] = []
    pos = 0
    text = expression
    while pos < len(text):
        if text[pos:].strip() == "":
            break
        match = _TOKEN_RE.match(text, pos)
        if match is None or match.end() == pos:
            snippet = text[pos:].strip()[:20]
            raise ExpressionEvaluationError(f"Unsupported token {snippet!r}")
        kind = match.lastgroup or ""
        tokens.append((kind, match.group(kind)))
        pos = match.end()
    return tokens


class _OperatorParser:
    """Recursive-descent parser producing a tuple AST (no eval)."""

    def __init__(self, tokens: list[tuple[str, str]]) -> None:
        self._tokens = tokens
        self._idx = 0

    def parse(self) -> tuple[Any, ...]:
        if not self._tokens:
            raise ExpressionEvaluationError("Empty expression")
        node = self._ternary()
        if self._idx != len(self._tokens):
            raise ExpressionEvaluationError(f"Unexpected token {self._tokens[self._idx][1]!r}")
        return node

    def _peek_op(self) -> str | None:
        if self._idx < len(self._tokens) and self._tokens[self._idx][0] == "op":
            return self._tokens[self._idx][1]
        return None

    def _take_op(self, *ops: str) -> str | None:
        op = self._peek_op()
        if op is not None and op in ops:
            self._idx += 1
            return op
        return None

    def _expect_op(self, op: str) -> None:
        if self._take_op(op) is None:
            raise ExpressionEvaluationError(f"Malformed expression: expected {op!r}")

    def _ternary(self) -> tuple[Any, ...]:
        cond = self._or()
        if self._take_op("?"):
            when_true = self._ternary()
            if self._take_op(":") is None:
                raise ExpressionEvaluationError("Malformed ternary expression")
            when_false = self._ternary()
            return ("ternary", cond, when_true, when_false)
        return cond

    def _or(self) -> tuple[Any, ...]:
        node = self._and()
        while self._take_op("||"):
            node = ("or", node, self._and())
        return node

    def _and(self) -> tuple[Any, ...]:
        node = self._equality()
        while self._take_op("&&"):
            node = ("and", node, self._equality())
        return node

    def _equality(self) -> tuple[Any, ...]:
        node = self._relational()
        while True:
            op = self._take_op("===", "!==", "==", "!=")
            if op is None:
                return node
            node = ("eq" if op in {"===", "=="} else "ne", node, self._relational(), op in {"===", "!=="})

    def _relational(self) -> tuple[Any, ...]:
        node = self._additive()
        while True:
            op = self._take_op(">=", "<=", ">", "<")
            if op is None:
                return node
            node = ("cmp", op, node, self._additive())

    def _additive(self) -> tuple[Any, ...]:
        node = self._multiplicative()
        while True:
            op = self._take_op("+", "-")
            if op is None:
                return node
            node = ("arith", op, node, self._multiplicative())

    def _multiplicative(self) -> tuple[Any, ...]:
        node = self._unary()
        while True:
            op = self._take_op("*", "/", "%")
            if op is None:
                return node
            node = ("arith", op, node, self._unary())

    def _unary(self) -> tuple[Any, ...]:
        if self._take_op("!"):
            return ("not", self._unary())
        if self._take_op("-"):
            return ("neg", self._unary())
        return self._primary()

    def _call_args(self) -> list[tuple[Any, ...]]:
        args: list[tuple[Any, ...]] = []
        if self._take_op(")"):
            return args
        while True:
            args.append(self._ternary())
            if self._take_op(","):
                continue
            self._expect_op(")")
            return args

    def _primary(self) -> tuple[Any, ...]:
        if self._idx >= len(self._tokens):
            raise ExpressionEvaluationError("Malformed expression: unexpected end")
        kind, text = self._tokens[self._idx]
        if kind == "op":
            if text == "(":
                self._idx += 1
                node = self._ternary()
                self._expect_op(")")
                return node
            raise ExpressionEvaluationError(f"Unsupported token {text!r}")
        self._idx += 1
        if kind == "num":
            return ("lit", float(text) if "." in text else int(text))
        if kind == "str":
            return ("lit", re.sub(r"\\(.)", r"\1", text[1:-1]))
        lowered = text.lower()
        if lowered in {"true", "false"}:
            return ("lit", lowered == "true")
        if lowered == "null":
            return ("lit", None)
        if self._take_op("("):
            args = self._call_args()
            if lowered.endswith(".includes"):
                if len(args) != 1:
                    raise ExpressionEvaluationError("includes() expects exactly one argument")
                return ("includes", text[: -len(".includes")], args[0])
            if lowered not in _FUNCTION_ARITY:
                raise ExpressionEvaluationError(f"Unsupported function {text!r}")
            low, high = _FUNCTION_ARITY[lowered]
            if len(args) < low or (high is not None and len(args) > high):
                raise ExpressionEvaluationError(f"{lowered}() received {len(args)} argument(s)")
            return ("call", lowered, args)
        return ("ident", text)


def parse_operator_expression(expression: str) -> tuple[Any, ...]:
    """Parse ``expression`` into an AST; raises ``ExpressionEvaluationError`` on bad syntax."""

    return _OperatorParser(_tokenize(expression)).parse()


def _to_number(value: Any) -> int | float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return value
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        try:
            return int(text)
        except ValueError:
            try:
                return float(text)
            except ValueError:
                return None
    return None


def _truthy(value: Any) -> bool:
    if value is None:
        return False
    if isinstance(value, str):
        return value.strip() != "" and value.strip().lower() not in {"false", "0"}
    return bool(value)


def _resolve_ident(name: str, event: dict[str, Any]) -> Any:
    val = get_field_value(event, name)
    if val is None:
        val = event.get(name)
    return val


def _loose_equal(left: Any, right: Any) -> bool:
    ln, rn = _to_number(left), _to_number(right)
    if ln is not None and rn is not None:
        return ln == rn
    return _coerce_str(left) == _coerce_str(right)


def _require_number(value: Any, node: tuple[Any, ...]) -> int | float:
    num = _to_number(value)
    if num is None:
        label = node[1] if node and node[0] == "ident" else repr(value)
        raise ExpressionEvaluationError(f"Operand {label} is not numeric")
    return num


def _eval_node(node: tuple[Any, ...], event: dict[str, Any]) -> Any:
    kind = node[0]
    if kind == "lit":
        return node[1]
    if kind == "ident":
        return _resolve_ident(node[1], event)
    if kind == "ternary":
        return _eval_node(node[2] if _truthy(_eval_node(node[1], event)) else node[3], event)
    if kind == "or":
        left = _eval_node(node[1], event)
        return left if _truthy(left) else _eval_node(node[2], event)
    if kind == "and":
        left = _eval_node(node[1], event)
        return _eval_node(node[2], event) if _truthy(left) else left
    if kind == "not":
        return not _truthy(_eval_node(node[1], event))
    if kind == "neg":
        return -_require_number(_eval_node(node[1], event), node[1])
    if kind in {"eq", "ne"}:
        left_node, right_node = node[1], node[2]
        left = _eval_node(left_node, event)
        right = _eval_node(right_node, event)
        # Wizard-style unquoted operand: ``status == ok`` compares with the text "ok".
        if right is None and right_node[0] == "ident":
            right = right_node[1]
        equal = _loose_equal(left, right)
        return equal if kind == "eq" else not equal
    if kind == "cmp":
        op = node[1]
        left, right = _eval_node(node[2], event), _eval_node(node[3], event)
        ln, rn = _to_number(left), _to_number(right)
        if ln is not None and rn is not None:
            a: Any = ln
            b: Any = rn
        elif isinstance(left, str) and isinstance(right, str):
            a, b = left, right
        else:
            return False
        return {">=": a >= b, "<=": a <= b, ">": a > b, "<": a < b}[op]
    if kind == "arith":
        op = node[1]
        left, right = _eval_node(node[2], event), _eval_node(node[3], event)
        if op == "+" and (_to_number(left) is None or _to_number(right) is None):
            if isinstance(left, str) or isinstance(right, str):
                return _coerce_str(left) + _coerce_str(right)
        a_num = _require_number(left, node[2])
        b_num = _require_number(right, node[3])
        if op == "+":
            return a_num + b_num
        if op == "-":
            return a_num - b_num
        if op == "*":
            return a_num * b_num
        if b_num == 0:
            raise ExpressionEvaluationError("Division by zero")
        if op == "%":
            return a_num % b_num
        result = a_num / b_num
        if isinstance(a_num, int) and isinstance(b_num, int) and a_num % b_num == 0:
            return a_num // b_num
        return result
    if kind == "includes":
        haystack = _resolve_ident(node[1], event)
        needle = _eval_node(node[2], event)
        if isinstance(haystack, (list, tuple, set)):
            return needle in haystack
        return _coerce_str(needle) in _coerce_str(haystack)
    if kind == "call":
        name = node[1]
        args = [_eval_node(arg, event) for arg in node[2]]
        if name == "concat":
            return "".join(_coerce_str(a) for a in args)
        if name == "upper":
            return _coerce_str(args[0]).upper()
        if name == "lower":
            return _coerce_str(args[0]).lower()
        if name == "coalesce":
            for arg in args:
                if arg is not None and _coerce_str(arg) != "":
                    return arg
            return args[-1]
        return datetime.now(UTC).isoformat().replace("+00:00", "Z")
    raise ExpressionEvaluationError(f"Unsupported expression node {kind!r}")


def evaluate_operator_expression(expression: str, event: dict[str, Any]) -> Any:
    """Evaluate an operator expression (comparison/arithmetic/ternary/...) against ``event``."""

    return _eval_node(parse_operator_expression(expression), event)


def expression_syntax_error(expression: str) -> str | None:
    """Return a readable reason when ``expression`` cannot be evaluated, else ``None``."""

    text = expression.strip()
    if not text:
        return "Expression is empty"
    placeholder = _FIELD_REF_RE.sub("__field__", text)
    try:
        parse_operator_expression(placeholder)
    except ExpressionEvaluationError as exc:
        return str(exc)
    return None


def evaluate_condition_expression(condition: str, event: dict[str, Any]) -> bool:
    """Evaluate a Conditional-rule ``when`` clause (comparison / boolean expression)."""

    return _truthy(evaluate_operator_expression(condition, event))


def condition_syntax_error(condition: str) -> str | None:
    """Return a readable reason when a ``when`` clause cannot be evaluated, else ``None``."""

    return expression_syntax_error(condition)


def evaluate_calculated_expression(expression: str, event: dict[str, Any]) -> Any:
    """Evaluate a calculated enrichment expression against ``event``."""

    raw = expression.strip()
    if not raw:
        raise ExpressionEvaluationError("Empty expression")
    has_refs = "{{" in raw
    has_function = any(fn in raw.lower() for fn in (f"{name}(" for name in _FUNCTION_NAMES))
    if has_refs or has_function:
        candidate = _substitute_field_refs(raw, event) if has_refs else raw
        try:
            return _evaluate_function_expression(candidate, event)
        except ExpressionEvaluationError:
            # Operators around function calls / field references (for example
            # ``upper(a) == 'X' ? 1 : 2``) are handled by the operator parser.
            return evaluate_operator_expression(candidate, event)
    if _IDENT_RE.match(raw):
        val = get_field_value(event, raw)
        return val if val is not None else event.get(raw)
    return evaluate_operator_expression(raw, event)
