"""Unit tests for REMOTE_FILE_POLLING parsing and checkpoint helpers (no live SSH)."""

from __future__ import annotations

from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from app.sources import remote_file_ssh as rfs
from app.sources.adapters import remote_file_polling as rfp


def test_parse_ndjson_with_offsets() -> None:
    body = b'{"a":1}\n{"b":2}\n'
    out = rfp._parse_records_with_offsets(
        body,
        remote_path="/x.ndjson",
        parser_type="NDJSON",
        lenient_ndjson=True,
        encoding="utf-8",
        csv_delimiter=",",
        line_event_field="line",
        start_line_byte=0,
    )
    assert len(out) == 2
    assert out[0][0] == {"a": 1}
    assert out[1][0] == {"b": 2}
    assert out[0][1] <= out[1][1]


def test_parse_csv_delimiter() -> None:
    body = b"a;b\n1;2\n"
    out = rfp._parse_records_with_offsets(
        body,
        remote_path="/x.csv",
        parser_type="CSV",
        lenient_ndjson=True,
        encoding="utf-8",
        csv_delimiter=";",
        line_event_field="line",
        start_line_byte=0,
    )
    assert out[0][0] == {"a": "1", "b": "2"}


def test_should_skip_entire_file_resume_partial() -> None:
    ck = {
        "last_processed_file": "/data/a.ndjson",
        "last_processed_mtime": "2024-01-01T00:00:00Z",
        "last_processed_offset": 10,
        "last_processed_size": 100,
    }
    w_lm, w_key = rfp._watermark_tuple(ck)
    mtime = datetime(2024, 1, 1, tzinfo=timezone.utc).timestamp()
    assert not rfp._should_skip_entire_file(
        mtime,
        "/data/a.ndjson",
        200,
        ck,
        w_lm,
        w_key,
    )


def test_watermark_tuple_from_legacy_keys() -> None:
    ck = {"last_processed_key": "/b", "last_processed_last_modified": "2024-01-02T00:00:00Z"}
    lm, k = rfp._watermark_tuple(ck)
    assert k == "/b"
    assert lm is not None


def test_normalize_remote_file_transfer_protocol() -> None:
    assert rfp.normalize_remote_file_transfer_protocol("sftp") == "sftp"
    assert rfp.normalize_remote_file_transfer_protocol("SFTP") == "sftp"
    assert rfp.normalize_remote_file_transfer_protocol("sftp_compatible_scp") == "sftp_compatible_scp"
    assert rfp.normalize_remote_file_transfer_protocol("scp") == "sftp_compatible_scp"


def test_normalize_remote_file_transfer_protocol_invalid() -> None:
    with pytest.raises(rfp.SourceFetchError):
        rfp.normalize_remote_file_transfer_protocol("ftp")


def test_literal_remote_file_candidate_uses_stat_without_directory_listing() -> None:
    class FakeSftp:
        def stat(self, path: str) -> SimpleNamespace:
            assert path == "upload/e2e-remote.ndjson"
            return SimpleNamespace(st_mode=0o100644, st_mtime=123.5, st_size=42)

        def listdir_attr(self, _path: str) -> list[object]:
            raise AssertionError("literal filename must not list the whole directory")

    assert rfs.iter_remote_file_candidates(
        FakeSftp(),  # type: ignore[arg-type]
        base="upload",
        pattern="e2e-remote.ndjson",
        recursive=False,
    ) == [("upload/e2e-remote.ndjson", 123.5, 42)]


def test_glob_remote_file_candidate_keeps_directory_listing_path() -> None:
    class FakeSftp:
        def stat(self, _path: str) -> object:
            raise AssertionError("glob pattern must preserve directory listing")

        def listdir_attr(self, path: str) -> list[SimpleNamespace]:
            assert path == "upload"
            return [
                SimpleNamespace(filename="a.ndjson", st_mode=0o100644, st_mtime=2.0, st_size=20),
                SimpleNamespace(filename="ignore.txt", st_mode=0o100644, st_mtime=1.0, st_size=10),
            ]

    assert rfs.iter_remote_file_candidates(
        FakeSftp(),  # type: ignore[arg-type]
        base="upload",
        pattern="*.ndjson",
        recursive=False,
    ) == [("upload/a.ndjson", 2.0, 20)]


def test_fetch_via_scp_uses_scp_get_not_getfo(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, str] = {}

    class FakeScp:
        def __init__(self, _transport: object) -> None:
            pass

        def __enter__(self) -> FakeScp:
            return self

        def __exit__(self, *args: object) -> None:
            return None

        def get(self, remote_path: str, local_path: str) -> None:
            captured["remote_path"] = remote_path
            captured["local_path"] = local_path
            with open(local_path, "wb") as fh:
                fh.write(b"payload")

    class FakeTransport:
        pass

    class FakeClient:
        def get_transport(self) -> FakeTransport:
            return FakeTransport()

    monkeypatch.setattr(rfp, "SCPClient", FakeScp)
    body = rfp._fetch_via_scp(FakeClient(), "/remote/a.ndjson")  # type: ignore[arg-type]
    assert body == b"payload"
    assert captured["remote_path"] == "/remote/a.ndjson"
    assert captured["local_path"]
