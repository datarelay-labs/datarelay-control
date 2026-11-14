"""Query-string / echoed-text secret masking helpers (E-096)."""

from __future__ import annotations

import pytest

from app.security.secrets import (
    MASKED_SECRET_SENTINEL,
    is_secret_query_param_name,
    mask_secret_query_params_in_text,
    redact_secret_literals,
    sanitize_secret_echo,
)

_MASK = MASKED_SECRET_SENTINEL


@pytest.mark.parametrize(
    "name",
    [
        "api_key",
        "apikey",
        "api-key",
        "API_KEY",
        "access_token",
        "token",
        "key",
        "secret",
        "client_secret",
        "password",
        "sig",
        "signature",
        "X-Amz-Signature",
        "access%5Ftoken",
    ],
)
def test_common_secret_query_param_names_are_secret(name: str) -> None:
    assert is_secret_query_param_name(name) is True


@pytest.mark.parametrize("name", ["limit", "page", "since", "next_page_token", "q", "format"])
def test_ordinary_query_param_names_are_not_secret(name: str) -> None:
    assert is_secret_query_param_name(name) is False


def test_configured_extra_names_are_secret() -> None:
    assert is_secret_query_param_name("acct", frozenset({"acct"})) is True
    assert is_secret_query_param_name("ACCT", frozenset({"acct"})) is True
    assert is_secret_query_param_name("acct") is False


def test_mask_text_masks_values_but_keeps_names_and_other_params() -> None:
    text = "GET http://h:1/p?limit=2&api_key=abc123&page=3 -> HTTP 200"
    out = mask_secret_query_params_in_text(text)
    assert "abc123" not in out
    assert f"api_key={_MASK}" in out
    assert "limit=2" in out and "page=3" in out
    assert out.endswith("-> HTTP 200")


def test_mask_text_is_value_blind_for_typed_wrong_values() -> None:
    out = mask_secret_query_params_in_text("http://h/p?api_key=wrong-key-b8")
    assert "wrong-key-b8" not in out


def test_mask_text_handles_json_embedded_and_escaped_urls() -> None:
    body = '{"url": "http://h/p?access_token=tok-1&x=1", "again": "\\"http://h/q?sig=zzz9\\""}'
    out = mask_secret_query_params_in_text(body)
    assert "tok-1" not in out and "zzz9" not in out
    assert "x=1" in out


def test_mask_text_percent_encoded_name_and_extra_name() -> None:
    out = mask_secret_query_params_in_text("http://h/p?access%5Ftoken=v1&acct=v2", extra_names=frozenset({"acct"}))
    assert "v1" not in out and "v2" not in out


def test_mask_text_leaves_empty_values_and_already_masked() -> None:
    assert mask_secret_query_params_in_text("http://h/p?api_key=&x=1") == "http://h/p?api_key=&x=1"
    assert mask_secret_query_params_in_text(f"http://h/p?api_key={_MASK}") == f"http://h/p?api_key={_MASK}"


def test_redact_literals_ignores_short_values_and_masks_long_ones() -> None:
    assert redact_secret_literals("a long-secret-value here", ["long-secret-value"]) == f"a {_MASK} here"
    # Very short literals would garble ordinary text; name-based masking is the primary control.
    assert redact_secret_literals("HTTP 200 ok", ["200"]) == "HTTP 200 ok"


def test_redact_literals_covers_url_encoded_form() -> None:
    assert "p%40ss%2Fword" not in redact_secret_literals("x?k=p%40ss%2Fword", ["p@ss/word"])


def test_sanitize_secret_echo_walks_nested_structures() -> None:
    data = {
        "message": "GET http://h/p?api_key=K1234567 -> HTTP 200",
        "items": ["http://h/q?token=T1234567", 7, None, True],
        "nested": {"u": "http://h/r?sig=S1234567&a=b"},
        "n": 5,
    }
    out = sanitize_secret_echo(data, param_names=frozenset(), literals=["standalone-secret"])
    flat = repr(out)
    for leaked in ("K1234567", "T1234567", "S1234567"):
        assert leaked not in flat
    assert out["n"] == 5 and out["items"][1] == 7 and out["items"][3] is True
    assert "a=b" in out["nested"]["u"]


def test_product_diagnostic_cookie_name_list_is_not_masked() -> None:
    text = "body_mode=json; follow_redirects=false; cookies=sid,csrf; final_url=http://h/login"
    assert mask_secret_query_params_in_text(text) == text
