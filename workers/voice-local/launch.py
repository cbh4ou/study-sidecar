"""Start the voice worker with packaged CUDA libraries visible to CTranslate2."""

from __future__ import annotations

import os
import sys
from pathlib import Path


def main() -> None:
    env = os.environ.copy()
    libraries: list[str] = []
    try:
        import nvidia.cublas
        import nvidia.cudnn

        for package in (nvidia.cublas, nvidia.cudnn):
            for directory in package.__path__:
                path = Path(directory) / "lib"
                if path.is_dir():
                    libraries.append(str(path))
    except ImportError:
        pass
    if libraries:
        env["LD_LIBRARY_PATH"] = os.pathsep.join(
            [*libraries, *filter(None, [env.get("LD_LIBRARY_PATH")])]
        )
    env.setdefault("ONNX_PROVIDER", "CPUExecutionProvider")
    script = Path(__file__).with_name("server.py")
    os.execve(sys.executable, [sys.executable, str(script), *sys.argv[1:]], env)


if __name__ == "__main__":
    main()
