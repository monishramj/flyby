import ast
from pathlib import Path

import httpx

from reflex.server import app as reflex_app


async def test_reflex_health_reports_model_readiness_honestly():
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=reflex_app), base_url="http://test") as client:
        response = await client.get("/health")
    assert response.status_code == 200
    assert response.json()["model_ready"] is False  # no lifespan here, so no model loaded


def test_reflex_has_no_ground_station_or_network_client_imports():
    # Static guard only: this does not prove that all future dependencies are offline.
    forbidden = {"server", "pymongo", "xai_sdk", "httpx", "requests", "urllib", "aiohttp", "runtime"}
    root = Path(__file__).resolve().parents[1]
    for path in (root / "reflex").rglob("*.py"):
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
            if isinstance(node, ast.Import):
                names = [alias.name for alias in node.names]
            elif isinstance(node, ast.ImportFrom):
                names = [node.module or ""]
            else:
                continue
            assert not forbidden.intersection(name.split(".")[0] for name in names), path
