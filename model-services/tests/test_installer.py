"""Standard-library installer tests; all writes are confined to temporary fixtures."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest

PACKAGE = Path(__file__).resolve().parents[1]


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="eulalens-package-tests-")
        self.directory = Path(self.temp.name)
        self.root = self.directory / "deployment"
        self.root.mkdir()
        self.manifest = json.loads((PACKAGE / "manifest.json").read_text())

    def tearDown(self):
        self.temp.cleanup()

    def invoke(self, mode, package=PACKAGE):
        return subprocess.run([sys.executable, str(package / "install.py"), "--root", str(self.root), mode],
            capture_output=True, text=True, env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"})

    def clone_package(self):
        target = self.directory / "package"
        shutil.copytree(PACKAGE, target, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        return target

    def test_check_is_read_only_and_root_is_explicit(self):
        result = self.invoke("--check")
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertEqual(list(self.root.iterdir()), [])
        missing = subprocess.run([sys.executable, str(PACKAGE / "install.py"), "--apply"], capture_output=True)
        self.assertEqual(missing.returncode, 2)

    def test_apply_is_idempotent_and_preserves_secrets_and_weights(self):
        unrelated = self.root / "scripts_dev/hidream-o1-image-2604"
        (unrelated / "models").mkdir(parents=True)
        (unrelated / ".env").write_bytes(b"private-fixture-credential")
        (unrelated / "models/weights.safetensors").write_bytes(b"fixture-weights")
        result = self.invoke("--apply")
        self.assertEqual(result.returncode, 0, result.stderr)
        for tree in ("scripts_dev", "scripts"):
            for entry in self.manifest["files"]:
                target = self.root / tree / entry["path"]
                self.assertEqual(hashlib.sha256(target.read_bytes()).hexdigest(), entry["sha256"])
                self.assertEqual(stat.S_IMODE(target.stat().st_mode), int(entry["mode"], 8))
        self.assertEqual((unrelated / ".env").read_bytes(), b"private-fixture-credential")
        self.assertEqual((unrelated / "models/weights.safetensors").read_bytes(), b"fixture-weights")
        backups = list((self.root / ".model-service-backups").iterdir())
        self.assertEqual(self.invoke("--check").returncode, 0)
        self.assertEqual(self.invoke("--apply").returncode, 0)
        self.assertEqual(list((self.root / ".model-service-backups").iterdir()), backups)

    def test_changed_sources_get_private_timestamped_backups(self):
        target = self.root / "scripts_dev/service_runtime.py"
        target.parent.mkdir()
        target.write_bytes(b"original source")
        target.chmod(0o640)
        result = self.invoke("--apply")
        self.assertEqual(result.returncode, 0, result.stderr)
        backup_root = self.root / ".model-service-backups"
        backup = next(backup_root.iterdir())
        original = backup / "scripts_dev/service_runtime.py"
        self.assertEqual(original.read_bytes(), b"original source")
        for directory in (backup_root, backup):
            self.assertEqual(stat.S_IMODE(directory.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(original.stat().st_mode), 0o600)
        records = json.loads((backup / "changes.json").read_text())
        record = next(r for r in records if r["path"] == "scripts_dev/service_runtime.py")
        self.assertEqual(record["old_mode"], 0o640)
        self.assertTrue(record["existed"])
        self.assertNotIn(".env", [Path(r["path"]).name for r in records])

    def test_symlink_destinations_refused_before_source_changes(self):
        outside = self.directory / "outside"
        outside.mkdir()
        (self.root / "scripts_dev").mkdir()
        (self.root / "scripts_dev/ltx-2.3").symlink_to(outside, target_is_directory=True)
        result = self.invoke("--apply")
        self.assertEqual(result.returncode, 2)
        self.assertIn("Refusing symlink", result.stderr)
        self.assertFalse((self.root / "scripts_dev/service_runtime.py").exists())
        self.assertEqual(list(outside.iterdir()), [])

    def test_tampered_source_refused_before_target_changes(self):
        package = self.clone_package()
        (package / "service_runtime.py").write_text("tampered")
        result = self.invoke("--apply", package)
        self.assertEqual(result.returncode, 2)
        self.assertIn("checksum mismatch", result.stderr)
        self.assertEqual(list(self.root.iterdir()), [])

    def test_manifest_cannot_authorize_env_or_traversal(self):
        package = self.clone_package()
        manifest = json.loads((package / "manifest.json").read_text())
        for forbidden in (".env", "../escape.py"):
            manifest["files"][0]["path"] = forbidden
            (package / "manifest.json").write_text(json.dumps(manifest))
            result = self.invoke("--apply", package)
            self.assertEqual(result.returncode, 2)
            self.assertIn("allowlist", result.stderr)
        self.assertEqual(list(self.root.iterdir()), [])

    def test_concurrent_installer_is_refused(self):
        with (self.root / ".model-services-install.lock").open("w") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            result = self.invoke("--apply")
            self.assertEqual(result.returncode, 2)
            self.assertIn("Another model source installer", result.stderr)
            self.assertFalse((self.root / "scripts_dev").exists())


if __name__ == "__main__":
    unittest.main(verbosity=2)
