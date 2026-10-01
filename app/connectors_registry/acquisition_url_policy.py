"""Marketplace network acquisition URL security policy (M29.5B).

Validates candidate acquisition targets for future Connector Harvester / Git /
Remote Registry / evidence URL consumers.

This module does **not** perform network downloads or repository cloning.
Callers must inject DNS resolution and revalidate every redirect target.

DNS rebinding boundary
----------------------
Preflight URL validation alone cannot prevent DNS rebinding. A future
downloader MUST:

1. resolve the hostname;
2. validate resolved addresses via ``validate_resolved_target``;
3. connect only to an approved address/target (pin the validated address);
4. revalidate every redirect target from scratch with ``validate_redirect_target``.

Mixed public+private DNS answers are blocked by default.
"""

from __future__ import annotations

import ipaddress
import socket
from dataclasses import dataclass, field
from typing import Callable, Iterable, Sequence
from urllib.parse import urlparse

# Default allowed schemes — HTTPS only unless admin policy widens this.
DEFAULT_ALLOWED_SCHEMES: frozenset[str] = frozenset({"https"})

# Ports commonly abused / non-HTTP service ports we reject by default when set.
# Empty means: allow any numeric port that parses, except we still reject
# malformed ports. Administrators may restrict via ``allowed_ports``.
DEFAULT_BLOCKED_PORTS: frozenset[int] = frozenset()

# Cloud metadata / link-local special targets (also covered by link-local checks).
_METADATA_IPV4 = ipaddress.ip_address("169.254.169.254")

DnsResolver = Callable[[str], Sequence[str]]


class AcquisitionUrlPolicyError(ValueError):
    """Raised when an acquisition URL / target fails security policy."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class NetworkAcquisitionPolicyConfig:
    """Administrator-configurable acquisition restrictions (safe by default).

    Do not hardcode vendor domains. Provide allowlists when restricting.
    Empty allowlists mean "no host allowlist restriction" — IP safety rules
    still apply.
    """

    allowed_schemes: frozenset[str] = field(default_factory=lambda: DEFAULT_ALLOWED_SCHEMES)
    # When non-empty, hostname must match exactly or be a subdomain of an entry.
    allowed_hosts: frozenset[str] = field(default_factory=frozenset)
    # When non-empty, only these ports are permitted (in addition to scheme default).
    allowed_ports: frozenset[int] = field(default_factory=frozenset)
    blocked_ports: frozenset[int] = field(default_factory=lambda: DEFAULT_BLOCKED_PORTS)
    # Explicit opt-in for HTTP (still subject to host/IP rules). Prefer HTTPS.
    allow_http: bool = False
    # When True, mixed public+private DNS answers are blocked (default).
    block_mixed_dns_answers: bool = True


@dataclass(frozen=True)
class AcquisitionUrlValidationResult:
    """Successful URL structural validation (not a network fetch)."""

    url: str
    scheme: str
    hostname: str
    port: int | None
    is_ip_literal: bool


def _normalize_host(hostname: str) -> str:
    host = hostname.strip().rstrip(".").lower()
    # URL-encoded or bracketed IPv6 from urlparse may include brackets.
    if host.startswith("[") and host.endswith("]"):
        host = host[1:-1]
    return host


def _host_allowed(hostname: str, allowed_hosts: frozenset[str]) -> bool:
    if not allowed_hosts:
        return True
    host = _normalize_host(hostname)
    for entry in allowed_hosts:
        needle = entry.strip().rstrip(".").lower()
        if not needle:
            continue
        if host == needle or host.endswith("." + needle):
            return True
    return False


def _parse_port(url: str, parsed_port: int | None, scheme: str) -> int | None:
    # Detect malformed ports that urlparse may mishandle (e.g. non-numeric).
    # urlparse raises ValueError for some bad ports; callers catch that.
    if parsed_port is not None:
        return parsed_port
    # Scheme defaults — used only when port omitted.
    if scheme == "https":
        return 443
    if scheme == "http":
        return 80
    return None


def _reject(code: str, message: str) -> None:
    raise AcquisitionUrlPolicyError(code, message)


def _is_blocked_ip(addr: ipaddress.IPv4Address | ipaddress.IPv6Address) -> str | None:
    """Return a block reason code if address is unsafe for acquisition, else None."""

    if addr == _METADATA_IPV4:
        return "METADATA_IP_BLOCKED"
    # IPv6 mapped IPv4 — evaluate the embedded IPv4.
    if isinstance(addr, ipaddress.IPv6Address) and addr.ipv4_mapped is not None:
        return _is_blocked_ip(addr.ipv4_mapped)

    if addr.is_loopback:
        return "LOOPBACK_BLOCKED"
    if addr.is_unspecified:
        return "UNSPECIFIED_IP_BLOCKED"
    if addr.is_link_local:
        return "LINK_LOCAL_BLOCKED"
    if addr.is_multicast:
        return "MULTICAST_BLOCKED"
    if addr.is_reserved:
        return "RESERVED_IP_BLOCKED"
    if addr.is_private:
        return "PRIVATE_IP_BLOCKED"
    # Site-local (deprecated) / ULA covered by is_private for IPv6 in Python.
    if isinstance(addr, ipaddress.IPv6Address):
        # Unique local addresses fc00::/7 — is_private in modern Python.
        if addr.teredo is not None:
            # Validate the teredo client IPv4 as well.
            nested = _is_blocked_ip(addr.teredo[1])
            if nested:
                return nested
        if addr.sixtofour is not None:
            nested = _is_blocked_ip(addr.sixtofour)
            if nested:
                return nested
    return None


def validate_ip_address(address: str) -> None:
    """Validate a single resolved IP string against SSRF policy."""

    try:
        addr = ipaddress.ip_address(address.strip())
    except ValueError as exc:
        _reject("MALFORMED_IP", f"malformed IP address: {address!r}: {exc}")
    reason = _is_blocked_ip(addr)
    if reason:
        _reject(reason, f"acquisition target IP blocked ({reason}): {address}")


def validate_hostname_literal(hostname: str) -> None:
    """Reject localhost and other unsafe hostname literals before DNS."""

    host = _normalize_host(hostname)
    if not host:
        _reject("MALFORMED_HOSTNAME", "hostname is empty or malformed")
    if host == "localhost" or host.endswith(".localhost"):
        _reject("LOCALHOST_BLOCKED", f"localhost hostname blocked: {hostname!r}")
    # Reject obviously unsafe DNS names used for metadata.
    if host in {"metadata", "metadata.google.internal"}:
        _reject("METADATA_HOST_BLOCKED", f"metadata hostname blocked: {hostname!r}")


def validate_url(
    url: str,
    *,
    config: NetworkAcquisitionPolicyConfig | None = None,
) -> AcquisitionUrlValidationResult:
    """Validate acquisition URL structure and host policy (no network I/O)."""

    cfg = config or NetworkAcquisitionPolicyConfig()
    if not isinstance(url, str) or not url.strip():
        _reject("MALFORMED_URL", "acquisition URL must be a non-empty string")

    text = url.strip()
    if any(ord(ch) < 0x20 or ord(ch) == 0x7F for ch in text):
        _reject("MALFORMED_URL", "acquisition URL must not contain control characters")
    # Backslashes are interpreted inconsistently across URL parsers/clients and
    # can change authority boundaries; reject them before hostname validation.
    if "\\" in text:
        _reject("MALFORMED_URL", "acquisition URL must not contain backslashes")
    try:
        parsed = urlparse(text)
    except ValueError as exc:
        _reject("MALFORMED_URL", f"malformed acquisition URL: {exc}")

    scheme = (parsed.scheme or "").lower()
    allowed_schemes = set(cfg.allowed_schemes)
    if cfg.allow_http:
        allowed_schemes.add("http")

    if not scheme:
        _reject("UNSUPPORTED_SCHEME", "acquisition URL scheme is required")
    if scheme not in allowed_schemes:
        if scheme == "http" and not cfg.allow_http:
            _reject("HTTP_BLOCKED", "HTTP acquisition URLs are blocked by default; HTTPS required")
        _reject("UNSUPPORTED_SCHEME", f"unsupported acquisition URL scheme: {scheme!r}")

    if parsed.username is not None or parsed.password is not None:
        _reject("USERINFO_BLOCKED", "acquisition URLs must not contain username/password userinfo")

    hostname = parsed.hostname
    if hostname is None or not str(hostname).strip():
        _reject("MALFORMED_HOSTNAME", "acquisition URL hostname is missing or malformed")

    host = _normalize_host(str(hostname))
    validate_hostname_literal(host)

    try:
        port = _parse_port(text, parsed.port, scheme)
    except ValueError as exc:
        _reject("MALFORMED_PORT", f"malformed acquisition URL port: {exc}")

    if port is not None:
        if port < 1 or port > 65535:
            _reject("MALFORMED_PORT", f"acquisition URL port out of range: {port}")
        if port in cfg.blocked_ports:
            _reject("PORT_BLOCKED", f"acquisition URL port blocked by policy: {port}")
        if cfg.allowed_ports and port not in cfg.allowed_ports:
            # Always allow scheme default ports even when allowlist is set? No —
            # if allowlist is set, it is authoritative.
            _reject("PORT_NOT_ALLOWED", f"acquisition URL port not in allowlist: {port}")

    if not _host_allowed(host, cfg.allowed_hosts):
        _reject("HOST_NOT_ALLOWED", f"acquisition hostname not in allowlist: {host!r}")

    is_ip_literal = False
    try:
        ipaddress.ip_address(host)
    except ValueError:
        is_ip_literal = False
    else:
        is_ip_literal = True
        validate_ip_address(host)

    return AcquisitionUrlValidationResult(
        url=text,
        scheme=scheme,
        hostname=host,
        port=port,
        is_ip_literal=is_ip_literal,
    )


def validate_resolved_target(
    host: str,
    resolved_addresses: Sequence[str],
    *,
    config: NetworkAcquisitionPolicyConfig | None = None,
) -> list[str]:
    """Validate DNS resolution results for an acquisition hostname.

    Returns the list of approved address strings. Raises if any address is
    blocked, if the set is empty, or if mixed public/private answers appear
    when ``block_mixed_dns_answers`` is enabled.
    """

    cfg = config or NetworkAcquisitionPolicyConfig()
    host_norm = _normalize_host(host)
    validate_hostname_literal(host_norm)
    if not _host_allowed(host_norm, cfg.allowed_hosts):
        _reject("HOST_NOT_ALLOWED", f"acquisition hostname not in allowlist: {host_norm!r}")

    if not resolved_addresses:
        _reject("DNS_EMPTY", f"no DNS addresses resolved for host: {host_norm!r}")

    approved: list[str] = []
    blocked_codes: list[str] = []
    public_count = 0
    blocked_count = 0

    for raw in resolved_addresses:
        address = str(raw).strip()
        if not address:
            continue
        try:
            addr = ipaddress.ip_address(address)
        except ValueError as exc:
            _reject("MALFORMED_IP", f"malformed resolved address {address!r}: {exc}")
        reason = _is_blocked_ip(addr)
        if reason:
            blocked_codes.append(reason)
            blocked_count += 1
        else:
            public_count += 1
            approved.append(address)

    if blocked_count and public_count and cfg.block_mixed_dns_answers:
        _reject(
            "MIXED_DNS_PRIVATE_BLOCKED",
            (
                f"DNS for {host_norm!r} returned mixed public and private/unsafe "
                f"addresses; blocked by default ({', '.join(sorted(set(blocked_codes)))})"
            ),
        )

    if blocked_count and not public_count:
        code = blocked_codes[0] if blocked_codes else "PRIVATE_IP_BLOCKED"
        _reject(
            code,
            f"DNS for {host_norm!r} resolved only to blocked addresses: {list(resolved_addresses)!r}",
        )

    if not approved:
        _reject("DNS_EMPTY", f"no approved DNS addresses for host: {host_norm!r}")

    return approved


def validate_redirect_target(
    url: str,
    *,
    config: NetworkAcquisitionPolicyConfig | None = None,
    resolved_addresses: Sequence[str] | None = None,
) -> AcquisitionUrlValidationResult:
    """Revalidate a redirect target from scratch (do not trust the prior host)."""

    result = validate_url(url, config=config)
    if resolved_addresses is not None:
        validate_resolved_target(result.hostname, resolved_addresses, config=config)
    elif result.is_ip_literal:
        validate_ip_address(result.hostname)
    return result


def default_dns_resolver(hostname: str) -> list[str]:
    """Resolve hostname via ``socket.getaddrinfo`` (for callers that need DNS).

    Policy tests should inject a fake resolver. Production downloaders should
    pin the validated address after calling ``validate_resolved_target``.
    """

    host = _normalize_host(hostname)
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror as exc:
        raise AcquisitionUrlPolicyError("DNS_RESOLUTION_FAILED", f"DNS resolution failed for {host!r}: {exc}") from exc
    addresses: list[str] = []
    seen: set[str] = set()
    for info in infos:
        sockaddr = info[4]
        if not sockaddr:
            continue
        addr = str(sockaddr[0])
        if addr not in seen:
            seen.add(addr)
            addresses.append(addr)
    return addresses


def validate_url_with_dns(
    url: str,
    *,
    config: NetworkAcquisitionPolicyConfig | None = None,
    resolver: DnsResolver | None = None,
) -> tuple[AcquisitionUrlValidationResult, list[str]]:
    """Validate URL then resolve+validate DNS (still no HTTP fetch).

    Prefer injecting ``resolver`` in tests. When hostname is an IP literal,
    DNS resolution is skipped.
    """

    result = validate_url(url, config=config)
    if result.is_ip_literal:
        return result, [result.hostname]
    resolve = resolver or default_dns_resolver
    addresses = list(resolve(result.hostname))
    approved = validate_resolved_target(result.hostname, addresses, config=config)
    return result, approved


def looks_like_absolute_url(value: str) -> bool:
    """Return True when value appears to be an absolute URL with a scheme."""

    if not isinstance(value, str):
        return False
    text = value.strip()
    if "://" not in text:
        return False
    try:
        parsed = urlparse(text)
    except ValueError:
        return False
    return bool(parsed.scheme and parsed.netloc)


def validate_declared_external_urls(
    urls: Iterable[str],
    *,
    config: NetworkAcquisitionPolicyConfig | None = None,
) -> list[AcquisitionUrlValidationResult]:
    """Validate declared metadata URLs without fetching them.

    Non-URL strings are skipped (e.g. relative evidence paths).
    """

    results: list[AcquisitionUrlValidationResult] = []
    for raw in urls:
        if not looks_like_absolute_url(raw):
            continue
        results.append(validate_url(raw, config=config))
    return results
