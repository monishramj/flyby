"""Process-local CPU limits. Call before importing NumPy or PyTorch."""

import os
import sys


def set_threads(n: int) -> None:
    if isinstance(n, bool) or not isinstance(n, int) or n < 1:
        raise ValueError("Thread count must be a positive integer")
    for key in ("OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS", "NUMEXPR_NUM_THREADS"):
        os.environ[key] = str(n)
    if "torch" in sys.modules:
        sys.modules["torch"].set_num_threads(n)
