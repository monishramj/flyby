import sys
from pathlib import Path

import pytest


def test_windows_cache_writer_closes_handles_and_preserves_data(tmp_path):
    h5py = pytest.importorskip("h5py")
    import numpy as np
    from reflex.compat import write_h5_closed

    path = tmp_path / "nested" / "array.h5"
    for value in (np.array([b"R1", b"T4a"]), np.array([1.5, 2.5, 3.5])):
        write_h5_closed(path, value)
        with h5py.File(path, "r", swmr=True) as handle:
            np.testing.assert_array_equal(handle["data"][:], value)
        # On Windows this fails if the writer leaves its file handle open.
        renamed = path.with_suffix(".moved")
        path.rename(renamed)
        renamed.rename(path)


def test_scoped_patch_restores_functions_on_failure():
    pytest.importorskip("datamate")
    import datamate.directory
    import datamate.io
    from reflex.compat import datamate_windows_writer

    before = (datamate.io._write_h5, datamate.directory._write_h5)
    with pytest.raises(RuntimeError, match="example"):
        with datamate_windows_writer():
            raise RuntimeError("example")
    assert (datamate.io._write_h5, datamate.directory._write_h5) == before
