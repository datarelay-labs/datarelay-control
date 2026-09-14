"""Pydantic schemas for Connector API."""

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

AuthType = Literal[
    "no_auth",
    "basic",
    "bearer",
    "api_key",
    "oauth2_client_credentials",
    "session_login",
    "jwt_refresh_token",
    "vendor_jwt_exchange",
]
ApiKeyLocation = Literal["headers", "query_params"]
AuthHealthCheckInterval = Literal["disabled", "15m", "1h", "6h", "24h"]
ConnectorType = Literal["generic_http", "s3_compatible", "relational_database", "remote_file", "webhook_receiver"]
SourceType = Literal[
    "HTTP_API_POLLING",
    "S3_OBJECT_POLLING",
    "S3",
    "DATABASE_QUERY",
    "REMOTE_FILE_POLLING",
    "REMOTE_FILE",
    "WEBHOOK_RECEIVER",
    "WEBHOOK",
]


class ConnectorBase(BaseModel):
    """Shared connector/source writable fields."""

    name: str | None = Field(default=None)
    product_group: str | None = Field(
        default=None,
        max_length=128,
        description="Operator-facing source product label (e.g. CrowdStrike, Okta).",
    )
    description: str | None = None
    status: str | None = None
    connector_type: ConnectorType = "generic_http"

    host: str | None = None
    base_url: str | None = None
    verify_ssl: bool = True
    http_proxy: str | None = None
    common_headers: dict[str, str] | None = None
    source_type: SourceType = "HTTP_API_POLLING"

    auth_type: AuthType | None = None
    basic_username: str | None = None
    basic_password: str | None = None
    bearer_token: str | None = None
    api_key_name: str | None = None
    api_key_value: str | None = None
    api_key_location: ApiKeyLocation | None = None
    oauth2_client_id: str | None = None
    oauth2_client_secret: str | None = None
    oauth2_token_url: str | None = None
    oauth2_scope: str | None = None
    login_url: str | None = None
    login_path: str | None = None
    login_method: str | None = None
    login_headers: dict[str, str] | None = None
    login_body_template: dict[str, Any] | None = None
    login_body_mode: str | None = None
    login_body_raw: str | None = None
    login_allow_redirects: bool | None = None
    session_cookie_name: str | None = None
    login_username: str | None = None
    login_password: str | None = None
    preflight_enabled: bool | None = None
    preflight_method: str | None = None
    preflight_path: str | None = None
    preflight_url: str | None = None
    preflight_headers: dict[str, str] | None = None
    preflight_body_raw: str | None = None
    preflight_follow_redirects: bool | None = None
    login_query_params: dict[str, str] | None = None
    session_login_extractions: list[dict[str, Any]] | None = None
    csrf_extract: dict[str, Any] | None = None
    refresh_token: str | None = None
    token_url: str | None = None
    token_path: str | None = None
    token_http_method: str | None = None
    refresh_token_header_name: str | None = None
    refresh_token_header_prefix: str | None = None
    access_token_json_path: str | None = None
    access_token_header_name: str | None = None
    access_token_header_prefix: str | None = None
    token_ttl_seconds: int | None = None
    user_id: str | None = None
    api_key: str | None = None
    token_method: str | None = None
    token_auth_mode: str | None = None
    token_content_type: str | None = None
    token_body_mode: str | None = None
    token_body: str | None = None
    access_token_injection: str | None = None
    access_token_query_name: str | None = None
    token_custom_headers: dict[str, Any] | None = None

    # S3-compatible object polling (stored on Source.config_json; ignored for HTTP_API_POLLING).
    endpoint_url: str | None = None
    bucket: str | None = None
    region: str | None = Field(default=None, description="AWS region or MinIO default (e.g. us-east-1).")
    access_key: str | None = None
    secret_key: str | None = None
    prefix: str | None = Field(default=None, description="Optional key prefix filter.")
    object_key_pattern: str | None = Field(default=None, description="Optional fnmatch-style object key filter after prefix.")
    path_style_access: bool | None = Field(default=None, description="Path-style addressing (typical for MinIO).")
    use_ssl: bool | None = Field(default=None, description="Use TLS when talking to endpoint_url.")

    # DATABASE_QUERY (relational source; stored on Source.config_json; ignored for HTTP/S3).
    db_type: str | None = Field(default=None, description="POSTGRESQL.")
    database: str | None = Field(default=None, description="Initial database / catalog name.")
    port: int | None = Field(default=None, ge=1, le=65535, description="Database listener port (DATABASE_QUERY).")
    db_username: str | None = None
    db_password: str | None = None
    ssl_mode: str | None = Field(default=None, description="SSL mode for DATABASE_QUERY (e.g. DISABLE, PREFER, REQUIRE).")
    connection_timeout_seconds: int | None = Field(default=None, ge=1, le=600)

    # REMOTE_FILE_POLLING (SFTP or SFTP-compatible SCP mode; stored on Source.config_json).
    remote_username: str | None = Field(default=None, description="SSH/SFTP username.")
    remote_password: str | None = Field(default=None, description="SSH password (write-only).")
    remote_file_protocol: str | None = Field(
        default="sftp",
        description="sftp or sftp_compatible_scp (SFTP listing + SCPClient read; legacy scp normalized on save).",
    )
    remote_private_key: str | None = Field(default=None, description="PEM private key material (write-only).")
    remote_private_key_passphrase: str | None = Field(default=None, description="Passphrase for encrypted private keys (write-only).")
    known_hosts_policy: str | None = Field(
        default="strict",
        description="strict | accept_new_for_dev_only | insecure_skip_verify (legacy STRICT_FILE / INSECURE_* accepted).",
    )
    known_hosts_text: str | None = Field(default=None, description="Additional known_hosts lines (OpenSSH format).")

    # WEBHOOK_RECEIVER (push source; stored on Source.config_json/auth_json).
    receiver_key: str | None = Field(default=None, description="Stable receiver key; generated on create when omitted.")
    webhook_auth_mode: str | None = Field(default="no_auth", description="no_auth | shared_secret_header | bearer_token.")
    webhook_shared_secret: str | None = Field(default=None, description="Shared secret header value (write-only).")
    webhook_bearer_token: str | None = Field(default=None, description="Bearer token expected from inbound webhooks (write-only).")
    webhook_auth_header_name: str | None = Field(default=None, description="Header name for shared_secret_header mode.")
    max_request_bytes: int | None = Field(default=None, ge=1024, le=10 * 1024 * 1024)
    payload_preview: str | None = Field(default=None, description="Operator-provided sample payload for mapping preview.")
    auth_health_check_interval: AuthHealthCheckInterval = Field(
        default="disabled",
        description="Scheduled auth health probe interval (stored on Source operational metadata).",
    )


class ConnectorCreate(ConnectorBase):
    """Create Generic HTTP connector."""

    name: str
    auth_type: AuthType


class ConnectorUpdate(ConnectorBase):
    """Partial update connector.

    ``expected_updated_at`` guards the Connector row.
    ``expected_source_updated_at`` guards the owned primary Source row when present.
    """

    expected_updated_at: datetime
    expected_source_updated_at: datetime | None = None


class ConnectorAuthLabStep(BaseModel):
    name: str
    success: bool
    status_code: int | None = None
    message: str = ""


class ConnectorAuthLabEffectiveRequest(BaseModel):
    method: str
    url: str
    headers: dict[str, str] = Field(default_factory=dict)


class ConnectorAuthLabResponse(BaseModel):
    success: bool
    auth_type: str
    mode: str
    steps: list[ConnectorAuthLabStep] = Field(default_factory=list)
    effective_request: ConnectorAuthLabEffectiveRequest
    status_code: int | None = None
    response_sample: Any | None = None
    error_code: str | None = None
    message: str | None = None
    token_obtained: bool | None = None
    session_cookie_obtained: bool | None = None
    phase: str | None = Field(
        default=None,
        description="vendor_jwt_exchange: token_exchange | final_request on failure.",
    )
    token_request_method: str | None = None
    token_request_url: str | None = None
    token_request_headers_masked: dict[str, str] = Field(default_factory=dict)
    token_request_body_mode: str | None = None
    token_response_status_code: int | None = None
    token_response_headers_masked: dict[str, str] = Field(default_factory=dict)
    token_response_body_masked: str | None = None
    final_request_method: str | None = None
    final_request_url: str | None = None
    final_request_headers_masked: dict[str, str] = Field(default_factory=dict)
    final_response_status_code: int | None = None
    final_response_headers_masked: dict[str, str] = Field(default_factory=dict)
    final_response_body: str | None = None
    # Server-only: Stream API Test and preview flows read these fields.
    raw_body_preview: str | None = Field(default=None, exclude=True)
    parsed_json_preview: Any | None = Field(default=None, exclude=True)
    target_response_headers: dict[str, str] = Field(default_factory=dict, exclude=True)
    session_login_body_mode: str | None = None
    session_login_follow_redirects: bool | None = None
    session_login_final_url: str | None = None
    session_login_redirect_chain: list[str] = Field(default_factory=list)
    session_login_cookie_names: list[str] = Field(default_factory=list)
    session_login_http_reason: str | None = None
    session_login_body_preview: str | None = None
    session_login_content_type: str | None = None
    session_login_request_encoding: str | None = None
    preflight_http_status: int | None = None
    preflight_final_url: str | None = None
    preflight_cookies: dict[str, str] | None = None
    extracted_variables: dict[str, str] | None = None
    template_render_preview: str | None = None
    computed_login_request_url: str | None = None
    login_url_resolution_warnings: list[str] = Field(default_factory=list)


class ConnectorRead(BaseModel):
    """Connector returned to clients."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    product_group: str | None = None
    description: str | None = None
    status: str | None = None
    connector_type: ConnectorType = "generic_http"
    source_type: SourceType = "HTTP_API_POLLING"
    source_id: int | None = None
    stream_count: int = 0
    host: str | None = None
    base_url: str | None = None
    verify_ssl: bool = True
    http_proxy: str | None = None
    common_headers: dict[str, str] = Field(default_factory=dict)
    auth_type: AuthType = "no_auth"
    auth: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime | None = None
    updated_at: datetime | None = None
    source_updated_at: datetime | None = None
    # Populated when source_type is S3_OBJECT_POLLING (secret_key never returned; use secret_key_configured).
    endpoint_url: str | None = None
    bucket: str | None = None
    region: str | None = None
    prefix: str | None = None
    object_key_pattern: str | None = None
    path_style_access: bool | None = None
    use_ssl: bool | None = None
    access_key: str | None = None
    secret_key_configured: bool | None = None
    db_type: str | None = None
    database: str | None = None
    port: int | None = None
    db_username: str | None = None
    db_password_configured: bool | None = None
    ssl_mode: str | None = None
    connection_timeout_seconds: int | None = None
    remote_username: str | None = None
    remote_password_configured: bool | None = None
    known_hosts_policy: str | None = None
    remote_file_protocol: str | None = None
    remote_private_key_configured: bool | None = None
    remote_private_key_passphrase_configured: bool | None = None
    known_hosts_configured: bool | None = None
    receiver_key: str | None = None
    receiver_path: str | None = None
    webhook_auth_mode: str | None = None
    webhook_auth_header_name: str | None = None
    webhook_shared_secret_configured: bool | None = None
    webhook_bearer_token_configured: bool | None = None
    max_request_bytes: int | None = None
    payload_preview: str | None = None
    auth_health_check_interval: AuthHealthCheckInterval = "disabled"
    last_auth_check_at: datetime | None = None
    last_auth_check_status: Literal["success", "failed"] | None = None
    last_auth_error: str | None = None
