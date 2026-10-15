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


def test_feed_tick_runs_independent_source_families_in_parallel(monkeypatch):
    import threading

    env = SimpleNamespace(
        pg_fixture_url="postgresql://unused",
        mysql_fixture_url="mysql://unused",
        mariadb_fixture_url="mysql://unused",
        minio_prefix_visible="e2e-s3/",
        minio_prefix_validation="security/",
        sftp_password="",
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

    pg_started = threading.Event()
    webhook_started = threading.Event()
    overlapped: list[bool] = []

    def fake_pg(*args, table: str, **kwargs):
        if table == "security_events":
            pg_started.set()
            overlapped.append(webhook_started.wait(timeout=0.25))

    def fake_webhook(*args, **kwargs):
        webhook_started.set()
        overlapped.append(pg_started.wait(timeout=0.25))

    monkeypatch.setattr(feeder, "_insert_postgres_rows", fake_pg)
    monkeypatch.setattr(feeder, "_insert_mysql_rows", lambda *args, **kwargs: None)
    monkeypatch.setattr(feeder, "_upload_s3_ndjson", lambda *args, **kwargs: None)
    monkeypatch.setattr(feeder, "_upload_remote_file", lambda *args, **kwargs: None)
    monkeypatch.setattr(feeder, "_post_webhook_events", fake_webhook)

    feeder.run_lab_throughput_feed_tick(high_volume=True)

    assert overlapped == [True, True]


def test_tick_wait_subtracts_work_duration():
    assert feeder._remaining_tick_wait(tick_seconds=1.0, elapsed_seconds=0.2) == 0.8
    assert feeder._remaining_tick_wait(tick_seconds=1.0, elapsed_seconds=1.4) == 0.0


def test_webhook_events_are_posted_as_one_batch(monkeypatch):
    calls: list[list[dict[str, str]]] = []

    class Response:
        status_code = 200
        text = "ok"

    class Client:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def post(self, url, *, headers, json):
            calls.append(json)
            return Response()

    monkeypatch.setattr(feeder.httpx, "Client", lambda **kwargs: Client())
    monkeypatch.setattr(feeder, "_next_seq", lambda: 1)
    env = SimpleNamespace(api_base_url="http://127.0.0.1:8000")

    feeder._post_webhook_events(env, count=2)

    assert len(calls) == 1
    assert [row["id"].split("-")[2] for row in calls[0]] == ["0", "1"]
    assert all(row["severity"] == "LOW" for row in calls[0])


def test_s3_feeder_reuses_bounded_rotating_object_ring(monkeypatch):
    keys: list[str] = []

    class Client:
        def create_bucket(self, **kwargs):
            return None

        def put_object(self, *, Bucket, Key, Body, ContentType):
            keys.append(Key)

    env = SimpleNamespace(
        minio_access_key="dev",
        minio_secret_key="dev",
        minio_buckets=("gdc-source-e2e",),
    )
    monkeypatch.setattr(feeder, "_s3_client", lambda env: Client())
    monkeypatch.setattr(feeder, "_S3_SLOT_CURSOR", 0)

    for _ in range(4):
        feeder._upload_s3_ndjson(env, prefix="bounded/", count=5)

    assert keys[:5] == [f"bounded/lab-feed-slot-{i:03d}.ndjson" for i in range(5)]
    assert keys[5:10] == [f"bounded/lab-feed-slot-{i:03d}.ndjson" for i in range(5, 10)]
    assert keys[10:15] == [f"bounded/lab-feed-slot-{i:03d}.ndjson" for i in range(10, 15)]
    assert keys[15:20] == [
        "bounded/lab-feed-slot-015.ndjson",
        "bounded/lab-feed-slot-000.ndjson",
        "bounded/lab-feed-slot-001.ndjson",
        "bounded/lab-feed-slot-002.ndjson",
        "bounded/lab-feed-slot-003.ndjson",
    ]
    assert len(set(keys)) == 16
