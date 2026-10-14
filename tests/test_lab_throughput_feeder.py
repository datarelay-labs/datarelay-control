from types import SimpleNamespace

from app.dev_validation_lab import lab_throughput_feeder as feeder


def test_visible_remote_file_rate_is_passed_to_sftp_feed(monkeypatch):
    env = SimpleNamespace(
        pg_fixture_url="postgresql://unused",
        mysql_fixture_url="mysql://unused",
        mariadb_fixture_url="mysql://unused",
        minio_prefix_visible="e2e-s3/",
        minio_prefix_validation="security/",
        sftp_password="dev",
        sftp_host="127.0.0.1",
        sftp_port=22222,
        sftp_user="gdc",
        scp_password="",
        scp_host="127.0.0.1",
        scp_port=22223,
        scp_user="gdc2",
    )
    monkeypatch.setattr(feeder, "_load_feeder_env", lambda: env)
    monkeypatch.setattr(
        feeder,
        "lab_feed_tick_rates",
        lambda high_volume: {
            "db_rows": 18,
            "s3_objects": 5,
            "remote_files": 6,
            "webhook_events": 17,
            "remote_visible_lines": 16,
        },
    )
    monkeypatch.setattr(feeder, "_insert_postgres_rows", lambda *args, **kwargs: None)
    monkeypatch.setattr(feeder, "_insert_mysql_rows", lambda *args, **kwargs: None)
    monkeypatch.setattr(feeder, "_upload_s3_ndjson", lambda *args, **kwargs: None)
    monkeypatch.setattr(feeder, "_post_webhook_events", lambda *args, **kwargs: None)

    remote_calls = []
    monkeypatch.setattr(
        feeder,
        "_upload_remote_file",
        lambda *args, **kwargs: remote_calls.append(kwargs),
    )

    feeder.run_lab_throughput_feed_tick(high_volume=True)

    assert len(remote_calls) == 1
    assert remote_calls[0]["count"] == 6
    assert remote_calls[0]["visible_lines"] == 16
