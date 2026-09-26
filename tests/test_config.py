import pytest
from server import config as ground
from reflex import config as reflex
from runtime import set_threads


def test_independent_service_configuration():
    assert ground.PORT != reflex.PORT
    assert reflex.DT_S == pytest.approx(0.02)
    assert reflex.VIZ_HZ <= reflex.FRAME_HZ
    assert 3 / reflex.A_BRAKE_MPS2 + 0.04 == pytest.approx(0.79)


def test_camera_settings_are_measured_but_brake_is_uncalibrated():
    assert reflex.FRAME_R == 96
    assert len(reflex.SUBTYPE_DIR) == 8
    assert reflex.THETA is None


def test_secret_settings_load_without_cloud_credentials(tmp_path):
    env_file = tmp_path / ".env"
    env_file.write_text("XAI_API_KEY=test-key\nXAI_MODEL=test-model\nMONGODB_URI=test-uri\n")
    cfg = ground.Settings(_env_file=env_file)
    assert cfg.XAI_MODEL == "test-model"
    assert cfg.XAI_API_KEY.get_secret_value() == "test-key"
    assert "test-key" not in repr(cfg)
    assert "test-uri" not in repr(cfg)


def test_thread_limit(monkeypatch):
    import os
    for name in ("OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS", "NUMEXPR_NUM_THREADS"):
        monkeypatch.setenv(name, "8")
    set_threads(4)
    assert os.environ["OMP_NUM_THREADS"] == "4"
    assert os.environ["OPENBLAS_NUM_THREADS"] == "4"
    with pytest.raises(ValueError):
        set_threads(0)
