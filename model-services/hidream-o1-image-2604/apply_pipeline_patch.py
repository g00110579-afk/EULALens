"""Idempotently install the small EULALens extension into a supported HiDream checkout."""
import ast
from pathlib import Path
import sys

path = Path(sys.argv[1]) / "models/pipeline.py"
source = path.read_text(encoding="utf-8-sig")
if "import os\n" not in source:
    source = "import os\n" + source
if "cancel_check=None," not in source:
    anchor = "        callback=None,\n"
    if anchor not in source:
        raise SystemExit("Unsupported HiDream signature; review the pipeline before patching.")
    source = source.replace(anchor, anchor + "        cancel_check=None,\n", 1)
loop = '    for step_idx, step_t in enumerate(tqdm.tqdm(sched.timesteps, desc="Generating")):\n'
if loop not in source:
    raise SystemExit("Unsupported HiDream loop; review cancellation integration.")
if loop + '        if cancel_check is not None:\n' not in source:
    source = source.replace(loop, loop + '        if cancel_check is not None:\n            cancel_check()\n', 1)
source = source.replace('"use_flash_attn": True,', '\"use_flash_attn\": os.environ.get("HIDREAM_USE_FLASH_ATTN", "false").lower() in {"1", "true", "yes", "on"},')
ast.parse(source)
path.write_text(source)
