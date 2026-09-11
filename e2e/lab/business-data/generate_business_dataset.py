#!/usr/bin/env python3
"""Deterministic shared business dataset generator for local E2E.

Fixed seed → identical logical entities every run.
Emits HTTP JSON, PostgreSQL SQL, S3/MinIO JSON+CSV, SFTP JSON/CSV, webhook events.

Usage:
  python3 e2e/lab/business-data/generate_business_dataset.py
  python3 e2e/lab/business-data/generate_business_dataset.py --seed 42 --out-dir e2e/lab/business-data
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import os
import random
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

DEFAULT_SEED = 42
ENTITY_COUNTS = {
    "customers": 100,
    "products": 50,
    "orders": 400,
    "payments": 250,
    "tickets": 50,
    "employees": 30,
}

BASE_TS = datetime(2026, 9, 11, 0, 0, 0, tzinfo=timezone.utc)


def _id(prefix: str, n: int) -> str:
    return f"{prefix}-{n:03d}"


def _email(local: str) -> str:
    return f"{local}@example.invalid"


def _ts(offset_minutes: int) -> str:
    return (BASE_TS + timedelta(minutes=offset_minutes)).strftime("%Y-%m-%dT%H:%M:%SZ")


def generate(seed: int = DEFAULT_SEED) -> dict[str, list[dict[str, Any]]]:
    rng = random.Random(seed)
    customers = []
    for i in range(1, ENTITY_COUNTS["customers"] + 1):
        customers.append(
            {
                "id": _id("customer", i),
                "customer_id": _id("customer", i),
                "name": f"Customer {i:03d}",
                "email": _email(f"customer{i:03d}"),
                "tier": rng.choice(["standard", "gold", "platinum"]),
                "region": rng.choice(["US", "EU", "APAC"]),
                "updated_at": _ts(i),
            }
        )

    products = []
    for i in range(1, ENTITY_COUNTS["products"] + 1):
        products.append(
            {
                "id": _id("product", i),
                "product_id": _id("product", i),
                "sku": f"SKU-{i:04d}",
                "name": f"Product {i:03d}",
                "unit_price": round(5.0 + (i % 40) * 2.5 + rng.random(), 2),
                "category": rng.choice(["widgets", "gadgets", "supplies"]),
                "updated_at": _ts(1000 + i),
            }
        )

    orders = []
    for i in range(1, ENTITY_COUNTS["orders"] + 1):
        cust = customers[(i - 1) % len(customers)]
        prod = products[(i - 1) % len(products)]
        qty = 1 + (i % 5)
        orders.append(
            {
                "id": _id("order", i),
                "order_id": _id("order", i),
                "customer_id": cust["customer_id"],
                "product_id": prod["product_id"],
                "quantity": qty,
                "amount": round(float(prod["unit_price"]) * qty, 2),
                "status": rng.choice(["open", "paid", "shipped", "cancelled"]),
                "ordered_at": _ts(2000 + i),
                "updated_at": _ts(2000 + i + 1),
            }
        )

    payments = []
    for i in range(1, ENTITY_COUNTS["payments"] + 1):
        order = orders[(i - 1) % len(orders)]
        payments.append(
            {
                "id": _id("payment", i),
                "payment_id": _id("payment", i),
                "order_id": order["order_id"],
                "customer_id": order["customer_id"],
                "amount": order["amount"],
                "method": rng.choice(["card", "ach", "wire"]),
                "status": rng.choice(["succeeded", "pending", "failed"]),
                "paid_at": _ts(3000 + i),
                "updated_at": _ts(3000 + i),
            }
        )

    tickets = []
    for i in range(1, ENTITY_COUNTS["tickets"] + 1):
        cust = customers[(i - 1) % len(customers)]
        tickets.append(
            {
                "id": _id("ticket", i),
                "ticket_id": _id("ticket", i),
                "customer_id": cust["customer_id"],
                "subject": f"Support case {i:03d}",
                "status": rng.choice(["open", "pending", "resolved"]),
                "priority": rng.choice(["low", "medium", "high"]),
                "updated_at": _ts(4000 + i),
            }
        )

    employees = []
    for i in range(1, ENTITY_COUNTS["employees"] + 1):
        employees.append(
            {
                "id": _id("employee", i),
                "employee_id": _id("employee", i),
                "name": f"Employee {i:03d}",
                "email": _email(f"employee{i:03d}"),
                "department": rng.choice(["sales", "support", "ops", "eng"]),
                "updated_at": _ts(5000 + i),
            }
        )

    return {
        "customers": customers,
        "products": products,
        "orders": orders,
        "payments": payments,
        "tickets": tickets,
        "employees": employees,
        "_meta": {
            "seed": seed,
            "generator": "e2e/lab/business-data/generate_business_dataset.py",
            "deterministic": True,
            "counts": {k: len(v) if isinstance(v, list) else v for k, v in ENTITY_COUNTS.items()},
            "canonical_ids_sample": {
                "customer_id": "customer-001",
                "product_id": "product-001",
                "order_id": "order-001",
                "payment_id": "payment-001",
                "ticket_id": "ticket-001",
                "employee_id": "employee-001",
            },
        },
    }


def dataset_fingerprint(dataset: dict[str, Any]) -> str:
    payload = {k: v for k, v in dataset.items() if not str(k).startswith("_")}
    raw = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def write_http_json(out_dir: Path, dataset: dict[str, Any]) -> None:
    http_dir = out_dir / "http"
    http_dir.mkdir(parents=True, exist_ok=True)
    for entity in ("customers", "products", "orders", "payments", "tickets", "employees"):
        body = {"data": dataset[entity], "e2e_dataset": "shared-business-v1"}
        (http_dir / f"{entity}.json").write_text(json.dumps(body, indent=2) + "\n", encoding="utf-8")
    # Canonical small slice used by cross-source consistency (first 5 customers + related).
    canonical = {
        "data": {
            "customers": dataset["customers"][:5],
            "products": dataset["products"][:5],
            "orders": [o for o in dataset["orders"] if o["customer_id"] in {c["customer_id"] for c in dataset["customers"][:5]}][
                :10
            ],
        },
        "e2e_dataset": "shared-business-v1-canonical",
    }
    (http_dir / "canonical.json").write_text(json.dumps(canonical, indent=2) + "\n", encoding="utf-8")


def write_postgres_sql(out_dir: Path, dataset: dict[str, Any]) -> None:
    sql_path = out_dir / "postgres" / "shared_business_seed.sql"
    sql_path.parent.mkdir(parents=True, exist_ok=True)
    lines = [
        "-- Deterministic shared business dataset (seeded). Idempotent for E2E fixture DB.",
        "CREATE TABLE IF NOT EXISTS shared_business_customers (",
        "  customer_id TEXT PRIMARY KEY,",
        "  name TEXT NOT NULL,",
        "  email TEXT NOT NULL,",
        "  tier TEXT,",
        "  region TEXT,",
        "  updated_at TIMESTAMPTZ NOT NULL",
        ");",
        "CREATE TABLE IF NOT EXISTS shared_business_orders (",
        "  order_id TEXT PRIMARY KEY,",
        "  customer_id TEXT NOT NULL,",
        "  product_id TEXT NOT NULL,",
        "  quantity INT NOT NULL,",
        "  amount NUMERIC(12,2) NOT NULL,",
        "  status TEXT,",
        "  ordered_at TIMESTAMPTZ NOT NULL,",
        "  updated_at TIMESTAMPTZ NOT NULL",
        ");",
        "CREATE TABLE IF NOT EXISTS shared_business_tickets (",
        "  ticket_id TEXT PRIMARY KEY,",
        "  customer_id TEXT NOT NULL,",
        "  subject TEXT,",
        "  status TEXT,",
        "  priority TEXT,",
        "  updated_at TIMESTAMPTZ NOT NULL",
        ");",
        "DELETE FROM shared_business_tickets;",
        "DELETE FROM shared_business_orders;",
        "DELETE FROM shared_business_customers;",
    ]
    for c in dataset["customers"]:
        lines.append(
            "INSERT INTO shared_business_customers "
            f"(customer_id, name, email, tier, region, updated_at) VALUES "
            f"('{c['customer_id']}', '{c['name']}', '{c['email']}', '{c['tier']}', '{c['region']}', '{c['updated_at']}');"
        )
    for o in dataset["orders"]:
        lines.append(
            "INSERT INTO shared_business_orders "
            f"(order_id, customer_id, product_id, quantity, amount, status, ordered_at, updated_at) VALUES "
            f"('{o['order_id']}', '{o['customer_id']}', '{o['product_id']}', {o['quantity']}, {o['amount']}, "
            f"'{o['status']}', '{o['ordered_at']}', '{o['updated_at']}');"
        )
    for t in dataset["tickets"]:
        lines.append(
            "INSERT INTO shared_business_tickets "
            f"(ticket_id, customer_id, subject, status, priority, updated_at) VALUES "
            f"('{t['ticket_id']}', '{t['customer_id']}', '{t['subject'].replace(chr(39), chr(39)+chr(39))}', "
            f"'{t['status']}', '{t['priority']}', '{t['updated_at']}');"
        )
    # Incremental helper table for checkpoint/new-data tests.
    lines.extend(
        [
            "CREATE TABLE IF NOT EXISTS shared_business_incremental (",
            "  id SERIAL PRIMARY KEY,",
            "  record_id TEXT NOT NULL UNIQUE,",
            "  customer_id TEXT NOT NULL,",
            "  payload JSONB NOT NULL,",
            "  updated_at TIMESTAMPTZ NOT NULL",
            ");",
            "DELETE FROM shared_business_incremental;",
            "INSERT INTO shared_business_incremental (record_id, customer_id, payload, updated_at) VALUES",
            "  ('incr-001', 'customer-001', '{\"note\":\"initial\"}'::jsonb, '2026-09-11T00:00:00Z'),",
            "  ('incr-002', 'customer-002', '{\"note\":\"initial\"}'::jsonb, '2026-09-11T00:01:00Z');",
        ]
    )
    sql_path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def _write_ndjson(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, sort_keys=True) + "\n")


def _write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not rows:
        path.write_text("", encoding="utf-8")
        return
    fieldnames = list(rows[0].keys())
    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=fieldnames)
    writer.writeheader()
    writer.writerows(rows)
    path.write_text(buf.getvalue(), encoding="utf-8")


def write_s3(out_dir: Path, dataset: dict[str, Any]) -> None:
    s3 = out_dir / "s3"
    _write_ndjson(s3 / "customers.ndjson", dataset["customers"])
    _write_ndjson(s3 / "orders.ndjson", dataset["orders"][:50])
    _write_csv(s3 / "customers.csv", dataset["customers"])
    _write_csv(s3 / "orders.csv", dataset["orders"][:50])


def write_sftp(out_dir: Path, dataset: dict[str, Any]) -> None:
    sftp = out_dir / "sftp"
    _write_ndjson(sftp / "customers.ndjson", dataset["customers"])
    _write_ndjson(sftp / "orders.ndjson", dataset["orders"][:50])
    _write_csv(sftp / "customers.csv", dataset["customers"])


def write_webhook_events(out_dir: Path, dataset: dict[str, Any]) -> None:
    wh = out_dir / "webhook"
    wh.mkdir(parents=True, exist_ok=True)
    events = []
    for c in dataset["customers"][:20]:
        events.append(
            {
                "event_type": "customer.upserted",
                "customer_id": c["customer_id"],
                "payload": c,
                "emitted_at": c["updated_at"],
            }
        )
    for o in dataset["orders"][:20]:
        events.append(
            {
                "event_type": "order.upserted",
                "order_id": o["order_id"],
                "customer_id": o["customer_id"],
                "payload": o,
                "emitted_at": o["updated_at"],
            }
        )
    (wh / "events.ndjson").write_text(
        "".join(json.dumps(e, sort_keys=True) + "\n" for e in events),
        encoding="utf-8",
    )


def write_wiremock_body_files(out_dir: Path, dataset: dict[str, Any]) -> None:
    """Body files for WireMock shared-business stubs."""
    bodies = out_dir / "wiremock-files"
    bodies.mkdir(parents=True, exist_ok=True)
    (bodies / "shared-customers.json").write_text(
        json.dumps({"data": dataset["customers"][:20], "e2e_dataset": "shared-business-v1"}, indent=2) + "\n",
        encoding="utf-8",
    )
    (bodies / "shared-orders.json").write_text(
        json.dumps({"data": dataset["orders"][:20], "e2e_dataset": "shared-business-v1"}, indent=2) + "\n",
        encoding="utf-8",
    )
    (bodies / "shared-canonical.json").write_text(
        json.dumps(
            {
                "data": dataset["customers"][:5],
                "e2e_dataset": "shared-business-v1-canonical",
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate deterministic shared business E2E dataset")
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    parser.add_argument(
        "--out-dir",
        type=Path,
        default=Path(__file__).resolve().parent,
    )
    args = parser.parse_args()
    out_dir: Path = args.out_dir
    out_dir.mkdir(parents=True, exist_ok=True)

    dataset = generate(args.seed)
    fp = dataset_fingerprint(dataset)
    dataset["_meta"]["fingerprint_sha256"] = fp

    (out_dir / "dataset.json").write_text(json.dumps(dataset, indent=2) + "\n", encoding="utf-8")
    (out_dir / "fingerprint.txt").write_text(fp + "\n", encoding="utf-8")
    write_http_json(out_dir, dataset)
    write_postgres_sql(out_dir, dataset)
    write_s3(out_dir, dataset)
    write_sftp(out_dir, dataset)
    write_webhook_events(out_dir, dataset)
    write_wiremock_body_files(out_dir, dataset)

    print(
        json.dumps(
            {
                "ok": True,
                "seed": args.seed,
                "fingerprint_sha256": fp,
                "counts": dataset["_meta"]["counts"],
                "out_dir": str(out_dir),
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
