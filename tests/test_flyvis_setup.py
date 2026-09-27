import pytest
from tools.prepare_flyvis import extract_checkpoint


def test_unverified_weights_are_rejected_before_extraction(tmp_path):
    with pytest.raises(ValueError, match="checksum mismatch"):
        extract_checkpoint(b"not the upstream pretrained archive", tmp_path)
    assert list(tmp_path.iterdir()) == []
