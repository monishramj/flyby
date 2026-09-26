"""Looming score and left/right imbalance from regional energies (README §4.8)."""

from reflex.config import EMA_ALPHA


class Readout:
    def __init__(self, alpha: float = EMA_ALPHA):
        self.alpha = alpha
        self.reset()

    def reset(self) -> None:
        self.S = 0.0
        self.dLR = 0.0

    def update(self, energies: dict[str, dict[str, float]]) -> tuple[float, float]:
        q = {region: e["out"] - e["in"] for region, e in energies.items()}
        a = self.alpha
        self.S = a * sum(q.values()) + (1 - a) * self.S
        self.dLR = a * (q["L"] - q["R"]) + (1 - a) * self.dLR
        return self.S, self.dLR
