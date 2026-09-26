"""A pauseable simulation clock with stable ordering for equal-time events."""
import asyncio
from heapq import heappop, heappush
import inspect
from itertools import count
from time import monotonic

from server.config import settings


class SimClock:
    def __init__(self, *, fast: bool = False, scale: float = settings.LIVE_TIME_SCALE):
        if scale <= 0:
            raise ValueError("Clock scale must be positive")
        self.fast, self.scale = fast, scale
        self._time, self._anchor = 0., monotonic()
        self._paused = True
        self._events: list[tuple] = []
        self._order = count()
        self._changed = asyncio.Event()

    @property
    def now(self) -> float:
        return self._time if self.fast or self._paused else self._time + (monotonic() - self._anchor) * self.scale

    @property
    def pending(self) -> bool:
        return bool(self._events)

    @property
    def paused(self) -> bool:
        return self._paused

    @property
    def next_time(self) -> float | None:
        return self._events[0][0] if self._events else None

    def pause(self) -> None:
        self._time = self.now
        self._paused = True
        self._changed.set()

    def resume(self) -> None:
        self._anchor = monotonic()
        self._paused = False
        self._changed.set()

    def call_at(self, t: float, callback) -> None:
        heappush(self._events, (max(t, self.now), next(self._order), callback))
        self._changed.set()

    async def advance_to(self, t: float) -> None:
        if t < self.now:
            raise ValueError("Simulation time cannot move backwards")
        while self._events and self._events[0][0] <= t:
            when, _, callback = heappop(self._events)
            self._time, self._anchor = when, monotonic()
            result = callback()
            if inspect.isawaitable(result):
                await result
        self._time, self._anchor = t, monotonic()

    async def run(self) -> None:
        self.resume()
        while self._events:
            self._changed.clear()
            if self._paused:
                await self._changed.wait()
                continue
            if self.fast:
                await self.advance_to(self._events[0][0])
                continue
            delay = max(0., (self._events[0][0] - self.now) / self.scale)
            try:
                await asyncio.wait_for(self._changed.wait(), delay)
            except TimeoutError:
                _, _, callback = heappop(self._events)
                result = callback()
                if inspect.isawaitable(result):
                    await result
