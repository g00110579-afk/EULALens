"""Compatibility entrypoint; the nested service owns configuration and model code."""
from pathlib import Path
import runpy
runpy.run_path(str(Path(__file__).resolve().parent / "hidream-o1-image-2604/hidream_image_server.py"), run_name="__main__" if __name__ == "__main__" else "hidream_service")
