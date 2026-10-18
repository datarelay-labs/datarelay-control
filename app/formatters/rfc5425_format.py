"""Minimal opt-in RFC 5424 JSON UTF-8 message for RFC 5425 TLS delivery.

P0-3 non-Git scratch candidate. Existing prefix+JSON newline mode remains the
default in the current sender and is *not* changed by this helper.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

from app.formatters.syslog_formatter import FACILITY_MAP, SEVERITY_MAP

_UTF8_BOM = b"\xef\xbb\xbf"
_HEADER_MAX = {"hostname":255, "app_name":48, "procid":128, "msgid":32}
_MAX_FRAME = 1024 * 1024


def _head_ascii(value: Any, field: str) -> str:
    text = str(value)
    max_chars = _HEADER_MAX[field]
    if not 1 <= len(text) <= max_chars:
        raise ValueError(f"{field} must be 1..{max_chars} characters")
    if any(not 33 <= ord(c) <= 126 for c in text):
        raise ValueError(f"{field} must contain only printable ASCII 33..126")
    return text


def _priority(config: dict[str,Any]) -> int:
    raw_facility = config.get("facility", "local0")
    raw_severity = config.get("severity", "info")
    facility = (
        FACILITY_MAP.get(raw_facility.lower())
        if isinstance(raw_facility,str) else raw_facility
    )
    severity = (
        SEVERITY_MAP.get(raw_severity.lower())
        if isinstance(raw_severity,str) else raw_severity
    )
    if type(facility) is not int or not 0 <= facility <= 23:
        raise ValueError("RFC 5424 facility must be in 0..23 or a supported name")
    if type(severity) is not int or not 0 <= severity <= 7:
        raise ValueError("RFC 5424 severity must be in 0..7 or a supported name")
    return facility*8+severity


def _timestamp(iso: str | None) -> str:
    if iso is None:
        dt = datetime.now(timezone.utc)
    elif iso == "-":
        return "-"
    else:
        try:
            dt = datetime.fromisoformat(iso.replace("Z","+00:00"))
        except ValueError as exc:
            raise ValueError("RFC 5424 timestamp is not valid ISO 8601") from exc
    if dt.tzinfo is None or dt.utcoffset() is None:
        raise ValueError("RFC 5424 timestamp must specify a timezone")
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00","Z")


def rfc5424_json(
    event: dict[str,Any],
    formatter_config: dict[str,Any],
    *,
    timestamp_iso: str | None = None,
) -> bytes:
    """Emit VERSION 1, NIL structured-data, BOM-prefixed UTF-8 JSON MSG."""
    if not isinstance(event,dict):
        raise ValueError("Syslog RFC event must be a JSON object")
    nested=formatter_config.get("syslog") or {}
    if not isinstance(nested,dict):
        raise ValueError("syslog formatter configuration must be a dictionary")
    options=dict(formatter_config)
    options.update(nested)
    pri=_priority(options)
    hostname=_head_ascii(options.get("hostname","gdc"),"hostname")
    app_name=_head_ascii(options.get("app_name","generic-connector"),"app_name")
    procid=_head_ascii(options.get("procid","-"),"procid")
    msgid=_head_ascii(options.get("tag","event"),"msgid")
    stamp=_timestamp(timestamp_iso)
    header=f"<{pri}>1 {stamp} {hostname} {app_name} {procid} {msgid} - ".encode("ascii")
    msg=json.dumps(event,ensure_ascii=False,separators=(",",":"),allow_nan=False).encode("utf-8")
    wire=header+_UTF8_BOM+msg
    if len(wire)>_MAX_FRAME:
        raise ValueError("RFC 5425 Syslog message exceeds standard-mode size limit")
    return wire


def rfc5425_frame(message: bytes) -> bytes:
    """Octet-counted RFC 5425 frame (length includes BOM in message)."""
    if not isinstance(message,bytes) or not 0 < len(message) <= _MAX_FRAME:
        raise ValueError("Invalid RFC 5425 message bytes or size")
    return str(len(message)).encode("ascii")+b" "+message
