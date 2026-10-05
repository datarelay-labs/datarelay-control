from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def _read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_frontend_builds_use_ephemeral_npmrc_secret() -> None:
    for path in ("docker/Dockerfile.api", "docker/Dockerfile.frontend"):
        text = _read(path)
        assert text.startswith("# syntax=docker/dockerfile:1.7\n")
        assert "RUN --mount=type=secret,id=npmrc,target=/root/.npmrc,required=true npm ci" in text
        assert "ARG NODE_AUTH_TOKEN" not in text
        assert "ENV NODE_AUTH_TOKEN" not in text


def test_compose_builds_wire_npmrc_secret_without_committed_credential() -> None:
    default = _read("docker-compose.yml")
    platform = _read("docker-compose.platform.yml")
    https = _read("deploy/docker-compose.https.yml")

    secret_source = "file: ${GDC_NPMRC_SECRET_FILE:-${HOME}/.npmrc}"
    assert secret_source in default
    assert secret_source in platform
    assert secret_source in https
    assert platform.count("- npmrc") >= 3
    assert https.count("- npmrc") >= 2

    npmrc = _read("frontend/.npmrc")
    assert "${NODE_AUTH_TOKEN}" in npmrc
    assert "ghp_" not in npmrc
    assert "github_pat_" not in npmrc
