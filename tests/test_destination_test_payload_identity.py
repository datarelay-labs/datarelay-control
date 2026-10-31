"""F-005: the destination connectivity-test payload carries the current product identity."""

from app.destinations.test_service import _test_payload


def test_destination_test_payload_uses_current_product_identity() -> None:
    payload = _test_payload()
    assert payload["datarelay"] is True
    assert payload["message"] == "DataRelay Control destination test"
    assert "Generic Data Connector" not in payload["message"]
    assert payload["timestamp"]
