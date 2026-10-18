"""Synthetic-only route sender compatibility tests for opt-in RFC 5425 mode.

All TLS writes are intercepted by a fake socket. No network or FUE modification.
"""
from __future__ import annotations

from copy import deepcopy
import math

import pytest

from app.delivery.syslog_sender import SyslogSender
from app.runtime.errors import DestinationSendError
from app.formatters.rfc5425_format import rfc5424_json, rfc5425_frame


class FakeTlsSocket:
    def __init__(self):
        self.frames: list[bytes] = []
        self.timeout = None
    def settimeout(self, timeout):
        self.timeout = timeout
    def sendall(self, data):
        self.frames.append(data)


@pytest.fixture
def tls(monkeypatch):
    sock = FakeTlsSocket()
    monkeypatch.setattr(
        "app.delivery.syslog_sender.build_syslog_tls_context",
        lambda cfg: object(),
    )
    monkeypatch.setattr(
        "app.delivery.syslog_sender._borrow_tls_socket",
        lambda **kwargs: sock,
    )
    return sock


def cfg(**overrides):
    val = {
        "host":"test-collector.invalid",
        "port":6514,
        "formatter_config":{
            "syslog_wire_mode":"rfc5425",
            "message_format":"json",
            "facility":"local0",
            "severity":"info",
            "hostname":"gdc-test",
            "app_name":"datarelay",
            "tag":"event",
        },
    }
    if "formatter_config" in overrides:
        val["formatter_config"].update(overrides.pop("formatter_config"))
    val.update(overrides)
    return val


def parse_frames(raw: bytes) -> list[bytes]:
    out=[]
    at=0
    while at<len(raw):
        space=raw.find(b" ",at)
        assert space>at, "bad frame header"
        size=raw[at:space]
        assert size.isdigit() and size[0:1]!=b"0"
        length=int(size)
        start=space+1
        end=start+length
        assert end<=len(raw)
        out.append(raw[start:end])
        at=end
    return out


def test_optional_standard_mode_one_tls_frame_with_bom(tls):
    event={"message":"한글 😊","id":1}
    baseline=deepcopy(event)
    SyslogSender().send(
        [event],cfg(),destination_type="SYSLOG_TLS",
        prefix_context={"timestamp_iso":"2026-10-18T10:00:00+09:00"},
    )
    assert len(tls.frames)==1
    decoded=parse_frames(b"".join(tls.frames))
    assert len(decoded)==1
    msg=decoded[0]
    assert msg.startswith(b"<134>1 2026-10-18T01:00:00Z gdc-test datarelay - event - ")
    assert b"\xef\xbb\xbf" in msg
    assert "한글 😊".encode("utf-8") in msg
    assert int(tls.frames[0].split(b" ",1)[0])==len(msg)
    assert event==baseline


def test_multiple_tls_frames_without_trailing_lf(tls):
    events=[{"n":i} for i in range(3)]
    SyslogSender().send(events,cfg(),destination_type="SYSLOG_TLS")
    assert len(tls.frames)==3
    raw=b"".join(tls.frames)
    assert len(parse_frames(raw))==3
    assert not raw.endswith(b"\n")


def test_event_raw_newline_stays_in_json_msg(tls):
    SyslogSender().send(
        [{"message":"A\n<13> spoofed"}],cfg(),destination_type="SYSLOG_TLS"
    )
    frames=parse_frames(b"".join(tls.frames))
    assert len(frames)==1
    assert b"\\n<13>" in frames[0]
    assert b"\n<13>" not in frames[0]


def test_legacy_tls_remains_newline_mode(tls):
    config=cfg(formatter_config={"syslog_wire_mode":"legacy"})
    SyslogSender().send([{"id":1}],config,destination_type="SYSLOG_TLS")
    assert tls.frames==[b'<134> gdc generic-connector event: {"id":1}\n']


def test_legacy_default_remains_unchanged(tls):
    config={"host":"test-collector.invalid","port":6514}
    SyslogSender().send([{"id":1}],config,destination_type="SYSLOG_TLS")
    assert tls.frames==[b'<134> gdc generic-connector event: {"id":1}\n']


def test_refuse_rfc_mode_without_tls(tls):
    with pytest.raises(DestinationSendError,match="requires SYSLOG_TLS"):
        SyslogSender().send(
            [{"id":1}],cfg(),destination_type="SYSLOG_TCP"
        )
    assert tls.frames==[]


def test_refuse_custom_legacy_prefix_with_standard_mode(tls):
    with pytest.raises(DestinationSendError,match="cannot combine"):
        SyslogSender().send(
            [{"id":1}],cfg(),destination_type="SYSLOG_TLS",
            formatter_override={"syslog_wire_mode":"rfc5425",
                                "message_prefix_enabled":True,
                                "message_prefix_template":"<13> custom"},
        )
    assert tls.frames==[]


def test_refuse_unknown_wire_mode(tls):
    with pytest.raises(DestinationSendError,match="Unsupported Syslog wire mode"):
        SyslogSender().send(
            [{"id":1}],cfg(formatter_config={"syslog_wire_mode":"other"}),
            destination_type="SYSLOG_TLS",
        )


@pytest.mark.parametrize("bad_host",["host name","test\n<13>spoof","장비"])
def test_invalid_hostname_rejected_with_no_socket_write(tls,bad_host):
    with pytest.raises(DestinationSendError,match="hostname"):
        SyslogSender().send(
            [{"id":1}],cfg(formatter_config={"hostname":bad_host}),
            destination_type="SYSLOG_TLS",
        )
    assert tls.frames==[]


def test_invalid_json_nan_fails_before_send(tls):
    with pytest.raises(DestinationSendError):
        SyslogSender().send([{"bad":math.nan}],cfg(),destination_type="SYSLOG_TLS")
    assert tls.frames==[]


def test_reject_naive_timestamp(tls):
    with pytest.raises(DestinationSendError,match="timezone"):
        SyslogSender().send(
            [{"id":1}],cfg(),destination_type="SYSLOG_TLS",
            prefix_context={"timestamp_iso":"2026-10-18T10:00:00"},
        )
    assert tls.frames==[]


def test_static_timestamp_nil_value(tls):
    SyslogSender().send(
        [{"id":1}],cfg(),destination_type="SYSLOG_TLS",
        prefix_context={"timestamp_iso":"-"},
    )
    msg=parse_frames(tls.frames[0])[0]
    assert msg.startswith(b"<134>1 - gdc-test")


def test_invalid_facility_range_fails(tls):
    with pytest.raises(DestinationSendError,match="facility"):
        SyslogSender().send(
            [{"id":1}],cfg(formatter_config={"facility":24}),
            destination_type="SYSLOG_TLS",
        )


def test_destination_flat_config_wire_mode(tls):
    config={
        "host":"test-collector.invalid","port":6514,
        "syslog_wire_mode":"rfc5425",
        "hostname":"gdc-test","app_name":"datarelay",
    }
    SyslogSender().send([{"id":1}],config,destination_type="SYSLOG_TLS")
    assert len(parse_frames(tls.frames[0]))==1


def test_empty_event_batch_does_not_open_tls_socket(tls):
    SyslogSender().send([],cfg(),destination_type="SYSLOG_TLS")
    assert tls.frames==[]


def test_helper_preserves_frame_exactness():
    message=rfc5424_json({"hello":"한글"}, {"facility":16,"severity":6})
    assert parse_frames(rfc5425_frame(message))==[message]


def test_invalid_syslog_config_is_rejected(tls):
    with pytest.raises(DestinationSendError,match="syslog formatter configuration"):
        SyslogSender().send(
            [{"id":1}],
            cfg(formatter_config={"syslog":"invalid"}),
            destination_type="SYSLOG_TLS",
        )


def test_route_overrides_destination_formatter_mode(tls):
    destination=cfg(formatter_config={"syslog_wire_mode":"legacy"})
    override={
        "syslog_wire_mode":"rfc5425",
        "message_format":"json",
        "facility":"local0",
        "severity":"info",
        "hostname":"route-override",
        "app_name":"control",
        "tag":"event",
    }
    SyslogSender().send(
        [{"id":1}],destination,destination_type="SYSLOG_TLS",
        formatter_override=override,
    )
    msg=parse_frames(tls.frames[0])[0]
    assert b"route-override" in msg
    assert msg.startswith(b"<134>1")

def test_legacy_syslog_prefix_control_chars_are_escaped_without_mutating_event():
    from app.formatters.message_prefix import format_single_delivery_line
    event={"device": "safe\n<13> forged", "keep":"original"}
    template={"message_prefix_enabled":True,"message_prefix_template":"{{event.device}}:"}
    actual=format_single_delivery_line(event,template,"SYSLOG_TCP")
    assert "\n" not in actual
    assert "\r" not in actual
    assert "\x00" not in actual
    assert "\\u000a" in actual
    assert event["device"]=="safe\n<13> forged"


def test_legacy_syslog_prefix_unicode_line_separators_are_escaped():
    from app.formatters.message_prefix import format_single_delivery_line
    event={"device": "a\u2028b\u0085c\u2029d"}
    config={"message_prefix_enabled":True,"message_prefix_template":"{{event.device}}"}
    actual=format_single_delivery_line(event,config,"SYSLOG_TLS")
    assert "\u2028" not in actual and "\u0085" not in actual and "\u2029" not in actual
    assert "\\u2028" in actual and "\\u0085" in actual and "\\u2029" in actual


def test_unaffected_legacy_syslog_prefix_remains_byte_compatible():
    from app.formatters.message_prefix import format_single_delivery_line
    result=format_single_delivery_line({"id":1},{}, "SYSLOG_TLS")
    assert result=="""<134> gdc generic-connector event: {"id":1}"""


def test_non_syslog_prefix_semantics_are_unchanged():
    from app.formatters.message_prefix import format_single_delivery_line
    event={"x":"a\nb"}
    result=format_single_delivery_line(
        event,{"message_prefix_enabled":True,"message_prefix_template":"{{event.x}}"},
        "WEBHOOK_POST"
    )
    assert result.startswith("a\nb ")
