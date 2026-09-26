"""The live incident picture. Decisions read snapshots from memory only."""
import inspect
from copy import deepcopy

from server.config import Settings, settings
from server.incident import merge


class IncidentStore:
    def __init__(self, run_id: str, gazetteer: dict, cfg: Settings = settings):
        self.run_id, self.gazetteer, self.cfg = run_id, gazetteer, cfg
        self._picture = merge.empty(run_id)
        self._hooks = []

    def on_update(self, hook) -> None:
        self._hooks.append(hook)

    def snapshot(self) -> dict:
        return deepcopy(self._picture)

    def public(self) -> dict:
        """The picture as the browser sees it: derived fields plus the raw reports."""
        picture = self.snapshot()
        picture["reports"] = [report for report in picture["reports"] if not report["retracted"]]
        return picture

    async def apply(self, parse, intel_id: str, t: float):
        self._picture = merge.apply(self._picture, parse, intel_id, t, self.gazetteer, self.cfg)
        picture = self.snapshot()
        for hook in self._hooks:
            result = hook(picture)
            if inspect.isawaitable(result):
                await result
        return picture
