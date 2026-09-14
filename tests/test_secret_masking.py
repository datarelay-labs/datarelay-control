from app.security.secrets import mask_http_headers, mask_secrets, mask_secrets_and_pem


def test_mask_secrets_masks_nested_sensitive_values():
    payload = {
        "basic_password": "pw",
        "auth": {
            "token": "abc",
            "client_secret": "secret",
            "normal": "ok",
        },
        "items": [{"api_key_value": "k"}, {"password": "p"}],
    }
    out = mask_secrets(payload)
    assert out["basic_password"] == "********"
    assert out["auth"]["token"] == "********"
    assert out["auth"]["client_secret"] == "********"
    assert out["auth"]["normal"] == "ok"
    assert out["items"][0]["api_key_value"] == "********"
    assert out["items"][1]["password"] == "********"


def test_mask_secrets_masks_access_key():
    out = mask_secrets({"access_key": "AKIAIOSFODNN7EXAMPLE"})
    assert out["access_key"] == "********"


def test_mask_secrets_and_pem_strips_inline_pem():
    pem = "-----BEGIN RSA PRIVATE KEY-----\nABC\n-----END RSA PRIVATE KEY-----"
    out = mask_secrets_and_pem({"note": pem, "x": 1})
    assert out["note"] == "********"
    assert out["x"] == 1


def test_mask_http_headers_masks_sensitive_headers():
    masked = mask_http_headers(
        {
            "Authorization": "Bearer secret-token",
            "Cookie": "session=abc",
            "X-API-Key": "super-secret",
            "Accept": "application/json",
        }
    )
    assert masked["Authorization"] == "********"
    assert masked["Cookie"] == "********"
    assert masked["X-API-Key"] == "********"
    assert masked["Accept"] == "application/json"


def test_mask_config_payload_masks_destination_headers_and_secrets():
    from app.security.secrets import mask_config_payload

    out = mask_config_payload(
        {
            "url": "https://hook.example/x",
            "api_key": "dest-api-key-secret",
            "headers": {
                "Authorization": "Bearer webhook-auth-token",
                "X-Custom": "still-secret-for-delivery",
                "Accept": "application/json",
            },
        },
        mask_all_header_values=True,
    )
    assert out["api_key"] == "********"
    assert out["headers"]["Authorization"] == "********"
    assert out["headers"]["X-Custom"] == "********"
    assert out["headers"]["Accept"] == "********"
    assert out["url"] == "https://hook.example/x"


def test_mask_param_map_and_url_query_secrets():
    from app.security.secrets import mask_param_map, mask_url_query_secrets

    params = mask_param_map({"limit": "10", "api_key": "qk-secret", "access_token": "at-secret"})
    assert params["limit"] == "10"
    assert params["api_key"] == "********"
    assert params["access_token"] == "********"
    url = mask_url_query_secrets("https://api.example/v1?page=1&token=leak-me&client_secret=cs")
    assert "leak-me" not in url
    assert "client_secret=cs" not in url
    from urllib.parse import unquote

    assert "********" in unquote(url)
    assert "page=1" in url


def test_preserve_masked_secrets_keeps_prior_values():
    from app.security.secrets import preserve_masked_secrets

    merged = preserve_masked_secrets(
        {"api_key": "********", "headers": {"Authorization": "********"}, "url": "https://x"},
        {"api_key": "real-key", "headers": {"Authorization": "Bearer real"}, "url": "https://old"},
    )
    assert merged["api_key"] == "real-key"
    assert merged["headers"]["Authorization"] == "Bearer real"
    assert merged["url"] == "https://x"

