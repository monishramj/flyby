from server.config import Settings


def test_constants_and_no_secrets_in_run_config():
    cfg = Settings(XAI_API_KEY="secret", MONGODB_URI="secret")
    assert cfg.AREA_M == 300 and cfg.MAX_PASSES == 2
    assert len(cfg.NOISE) == 7
    assert "secret" not in str(cfg.public_dict())
