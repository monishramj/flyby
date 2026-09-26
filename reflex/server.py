"""Independent process scaffold. No model or fake reflex is served yet."""

from runtime import set_threads
from reflex.config import CPU_THREADS, PORT

set_threads(CPU_THREADS)

from fastapi import FastAPI

app = FastAPI(title="FlyBy reflex")


@app.get("/health")
def health() -> dict:
    return {"service": "reflex", "status": "scaffold", "model_ready": False}


if __name__ == "__main__":
    import argparse
    import uvicorn

    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=PORT)
    args = parser.parse_args()
    uvicorn.run(app, host="127.0.0.1", port=args.port)
