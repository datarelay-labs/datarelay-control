from app.runtime import operational_snapshot_repository as repo


def test_route_diagnostic_failure_stages_include_policy_dispositions() -> None:
    assert {"policy_blocked", "policy_review_required", "policy_quarantine"} <= repo.ROUTE_DIAGNOSTIC_FAILURE_STAGES
    assert repo.FAILURE_STAGES <= repo.ROUTE_DIAGNOSTIC_FAILURE_STAGES


def test_destination_failures_remain_delivery_only() -> None:
    assert "policy_blocked" not in repo.FAILURE_STAGES
    assert "policy_quarantine" not in repo.FAILURE_STAGES
