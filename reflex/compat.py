"""Narrow Windows workaround for datamate 1.0.0's HDF5 writer.

Upstream opens a new HDF5 file, reads a nonexistent dataset, then tries to
unlink the still-open file. Windows rejects that unlink. Scope the replacement
to model construction, preserving the dataset format and SWMR behavior.
"""

from contextlib import contextmanager
from importlib.metadata import version
import sys


def write_h5_closed(path, value):
    import h5py
    import numpy as np

    path.parent.mkdir(parents=True, exist_ok=True)
    with h5py.File(path, mode="w", libver="latest") as handle:
        handle.create_dataset("data", data=np.asarray(value))
        handle.swmr_mode = True


@contextmanager
def datamate_windows_writer():
    if sys.platform != "win32" or version("datamate") != "1.0.0":
        yield False
        return
    import datamate.directory
    import datamate.io

    original_io = datamate.io._write_h5
    original_directory = datamate.directory._write_h5
    datamate.io._write_h5 = write_h5_closed
    datamate.directory._write_h5 = write_h5_closed
    try:
        yield True
    finally:
        datamate.io._write_h5 = original_io
        datamate.directory._write_h5 = original_directory
