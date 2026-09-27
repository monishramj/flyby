import os

import pytest

from reflex import config as reflex
from reflex.threads import set_threads


def test_reflex_timing_constants():
    assert reflex.PORT == 8001
    assert reflex.DT_S == pytest.approx(0.02)
    assert reflex.VIZ_HZ <= reflex.FRAME_HZ
    assert 3 / reflex.A_BRAKE_MPS2 + 0.04 == pytest.approx(0.79)


def test_camera_settings_are_measured_but_brake_is_uncalibrated():
    assert reflex.FRAME_R == 96
    assert len(reflex.SUBTYPE_DIR) == 8
    assert reflex.THETA is None


def test_thread_limit(monkeypatch):
    for name in ("OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS", "NUMEXPR_NUM_THREADS"):
        monkeypatch.setenv(name, "8")
    set_threads(4)
    assert os.environ["OMP_NUM_THREADS"] == "4"
    assert os.environ["OPENBLAS_NUM_THREADS"] == "4"
    with pytest.raises(ValueError):
        set_threads(0)
