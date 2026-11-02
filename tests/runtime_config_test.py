import contextlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('runtime_config', Path(__file__).resolve().parents[1] / 'tools/prepare_runtime.py')
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)

class RuntimeConfigTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name); self.project = self.root/'web'; self.project.mkdir()
        (self.project/'.env').write_text('# preserved\nQWEN_API_KEY=legacy\nUNRELATED=keep\n')
    def run_config(self, apply=False, occupied=False):
        argv = ['prepare_runtime.py', '--root', str(self.root), '--project', str(self.project)] + (['--apply'] if apply else [])
        output = io.StringIO()
        with patch('sys.argv', argv), patch.object(runtime.socket, 'socket') as socket, contextlib.redirect_stdout(output):
            socket.return_value.__enter__.return_value.connect_ex.return_value = 0 if occupied else 111
            code = runtime.main()
        return code, json.loads(output.getvalue())
    def test_default_does_not_write_or_print_secrets(self):
        before = (self.project/'.env').read_bytes()
        code, result = self.run_config()
        self.assertEqual(code, 1); self.assertFalse(result['ready'])
        self.assertEqual((self.project/'.env').read_bytes(), before)
        self.assertFalse((self.root/'scripts_dev').exists())
        self.assertNotIn('legacy', json.dumps(result))
    def test_running_services_prevent_config_rotation(self):
        before = (self.project/'.env').read_bytes()
        code, result = self.run_config(apply=True, occupied=True)
        self.assertEqual(code, 2); self.assertEqual(result['listening_ports'], [5050,8000,5052,5054])
        self.assertEqual((self.project/'.env').read_bytes(), before)
        self.assertFalse((self.root/'scripts_dev').exists())
    def test_atomic_configuration_aligns_keys_and_is_idempotent(self):
        code, result = self.run_config(apply=True)
        self.assertEqual(code, 0)
        web = runtime.read_env(self.project/'.env')
        qwen = runtime.read_env(self.root/'scripts_dev/qwen-3.5-9b/.env')
        image = runtime.read_env(self.root/'scripts_dev/hidream-o1-image-2604/.env')
        video = runtime.read_env(self.root/'scripts_dev/ltx-2.3/.env')
        self.assertEqual(web['QWEN_API_KEY'], qwen['VLLM_API_KEY'])
        self.assertEqual(web['HIDREAM_API_KEY'], image['HIDREAM_API_KEY'])
        self.assertEqual(web['VIDEO_API_KEY'], video['LTX_API_KEY'])
        self.assertGreaterEqual(len(web['QWEN_API_KEY']), 32)
        self.assertEqual(image['HIDREAM_WIDTH'], '2048'); self.assertEqual(web['UNRELATED'], 'keep')
        self.assertEqual((self.project/'.env').stat().st_mode & 0o777, 0o600)
        self.assertEqual(len(list((self.project/'.runtime/config-backups').glob('*/web.env'))), 1)
        self.assertNotIn(web['QWEN_API_KEY'], json.dumps(result))
        before = (self.project/'.env').read_bytes()
        code, result = self.run_config(apply=True, occupied=True)
        self.assertEqual(code, 0); self.assertEqual(result['updated_services'], [])
        self.assertEqual((self.project/'.env').read_bytes(), before)

if __name__ == '__main__': unittest.main()
