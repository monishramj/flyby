"""Ground-station scaffold; mission routes belong to Monish's lane."""

from runtime import set_threads
from server.config import CPU_THREADS

set_threads(CPU_THREADS)

from fastapi import FastAPI

app = FastAPI(title="FlyBy ground station")


@app.get("/health")
def health() -> dict:
    return {"service": "ground-station", "status": "scaffold", "mission_ready": False}
