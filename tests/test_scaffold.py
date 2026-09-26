import ast
from pathlib import Path
import httpx
import pytest
from server.app import app as ground_app
from reflex.server import app as reflex_app


@pytest.mark.parametrize("app,flag", [(ground_app, "mission_ready"), (reflex_app, "model_ready")])
async def test_services_report_honest_readiness(app, flag):
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get("/health")
    assert response.status_code == 200
    assert response.json()[flag] is False


def test_reflex_has_no_ground_station_or_network_client_imports():
    # Static guard only: this does not prove that all future dependencies are offline.
    forbidden = {"server", "pymongo", "xai_sdk", "httpx", "requests", "urllib", "aiohttp"}
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
