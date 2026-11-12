"""CPU-only regression suite. Never loads model weights or calls running services."""
from __future__ import annotations
import asyncio
from contextlib import contextmanager
import importlib.util
import hashlib
import io
import json
import math
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import wave
import struct
import array

SERVICE_ROOT = Path(__file__).resolve().parents[1]
ROOT = SERVICE_ROOT.parent
TEMP = tempfile.TemporaryDirectory(prefix="eulalens-model-tests-")
os.environ.update({"HIDREAM_API_KEY": "test-only-image-key", "LTX_API_KEY": "test-only-video-key",
    "HIDREAM_OUTPUT_DIR": str(Path(TEMP.name)/"images"), "LTX_OUTPUT_ROOT": str(Path(TEMP.name)/"videos"),
    "HIDREAM_WIDTH": "2048", "HIDREAM_HEIGHT": "2048", "HIDREAM_PRELOAD_ON_STARTUP": "false",
    "LTX_RESIDENT_PIPELINE": "false", "LTX_HOST": "127.0.0.1"})
sys.path.insert(0, str(SERVICE_ROOT))
import service_runtime as runtime

def load(name, relative):
    spec=importlib.util.spec_from_file_location(name,SERVICE_ROOT/relative)
    module=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

ltx=load("tested_ltx", "ltx-2.3/ltx_video_server.py")
image=load("tested_image", "hidream-o1-image-2604/hidream_image_server.py")
AUTH="Bearer test-only-image-key"

class Handler:
    def __init__(self,path="/",body=None,headers=None):
        raw=json.dumps(body).encode() if body is not None else b""
        self.path=path;self.headers={"Content-Length":str(len(raw)),**(headers or {})}
        self.rfile=io.BytesIO(raw);self.wfile=io.BytesIO();self.status=None;self.response_headers={}
    def send_response(self,status):self.status=int(status)
    def send_header(self,key,value):self.response_headers[key]=value
    def end_headers(self):pass

@contextmanager
def env_values(module, **values):
    old=module.ENV.copy();module.ENV.update(values)
    try:yield
    finally:module.ENV.clear();module.ENV.update(old)

class ModelTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(dir=TEMP.name)
        self.root=Path(self.temp.name)
        self.old_root,self.old_requests=ltx.OUTPUT_ROOT,ltx.REQUEST_ROOT
        ltx.OUTPUT_ROOT=self.root/"outputs";ltx.REQUEST_ROOT=ltx.OUTPUT_ROOT/"requests"
        ltx.ACTIVE_JOBS.clear();ltx.PENDING_CANCELLATIONS.clear()
    def tearDown(self):
        ltx.OUTPUT_ROOT,self.old_root=self.old_root,ltx.OUTPUT_ROOT
        ltx.REQUEST_ROOT=self.old_requests
        self.temp.cleanup()
    def test_unique_same_category_jobs(self):
        a=ltx.build_request_payload({"prompt":"one","jobId":"a","metadata":{"categoryId":"privacy"}})
        b=ltx.build_request_payload({"prompt":"two","jobId":"b","metadata":{"categoryId":"privacy"}})
        self.assertNotEqual(a["request_dir"],b["request_dir"])
    def test_video_limits_and_frames(self):
        for value in (-1,0,True,float("nan"),float("inf"),100000):
            with self.subTest(value=value),self.assertRaises(runtime.ServiceError):
                ltx.build_request_payload({"prompt":"x","duration_seconds":value})
        p=ltx.build_request_payload({"prompt":"x","duration_seconds":15,"frame_rate":12})
        self.assertEqual((p["num_frames"]-1)%8,0)
        self.assertEqual(p["duration"],p["num_frames"]/p["frame_rate"])
        for job in ("../x","", "x"*129):
            with self.assertRaises(runtime.ServiceError):ltx.build_request_payload({"prompt":"x","jobId":job})
    def test_artifact_containment_and_allowlist(self):
        root=self.root/"assets";root.mkdir();sibling=self.root/"assets-private";sibling.mkdir()
        (sibling/"secret.mp4").write_bytes(b"private")
        (root/"debug.json").write_text("private")
        (root/"link.mp4").symlink_to(sibling/"secret.mp4")
        for name in ("../assets-private/secret.mp4","debug.json","link.mp4"):
            with self.assertRaises(runtime.ServiceError):runtime.checked_artifact(root,name,{".mp4"})
    def test_ranges(self):
        path=self.root/"movie.mp4";path.write_bytes(b"0123456789")
        for value,status,data in [(None,200,b"0123456789"),("bytes=2-5",206,b"2345"),("bytes=-3",206,b"789"),("bytes=20-",416,b""),("bytes=1-2,4-5",416,b"")]:
            h=Handler(headers={} if value is None else {"Range":value});runtime.stream_artifact(h,path)
            self.assertEqual((h.status,h.wfile.getvalue()),(status,data))
    def test_auth_fail_closed(self):
        for key,header,status in [("",None,503),("secret",None,401),("secret","Bearer wrong",401)]:
            with self.assertRaises(runtime.ServiceError) as ctx:runtime.authorize(header,key)
            self.assertEqual(ctx.exception.status,status)
        runtime.authorize("Bearer secret","secret")
        h=Handler("/cancel",{"jobId":"x"});ltx.Handler.do_POST(h)
        self.assertEqual(h.status,401);self.assertFalse(ltx.PENDING_CANCELLATIONS)
    def test_video_http_contract_without_models(self):
        import urllib.request
        import urllib.error
        server=ltx.BoundedHTTPServer(('127.0.0.1',0),ltx.Handler)
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        base=f'http://127.0.0.1:{server.server_port}'
        try:
            with urllib.request.urlopen(base+'/health',timeout=2) as response:
                self.assertEqual(response.status,200);self.assertIn('ready',json.load(response))
            request=urllib.request.Request(base+'/cancel',data=b'{"jobId":"fixture"}',headers={'Content-Type':'application/json'})
            with self.assertRaises(urllib.error.HTTPError) as ctx:urllib.request.urlopen(request,timeout=2)
            self.assertEqual(ctx.exception.code,401)
            request.add_header('Authorization','Bearer test-only-video-key')
            with urllib.request.urlopen(request,timeout=2) as response:self.assertEqual(response.status,200)
            with patch.object(ltx,'_run_generation',lambda p:{'jobId':p['job_id'],'status':'completed'}):
                request=urllib.request.Request(base+'/generate',data=b'{"prompt":"fixture prompt","jobId":"fixture-generation"}',headers={'Content-Type':'application/json','Authorization':'Bearer test-only-video-key'})
                with urllib.request.urlopen(request,timeout=2) as response:
                    result=json.load(response);self.assertEqual(result['jobId'],'fixture-generation');self.assertEqual(result['status'],'completed')
        finally:server.shutdown();server.server_close();thread.join(2)
    def test_video_readiness_honors_runtime_override(self):
        with env_values(ltx,LTX_REPO=str(self.root/"absent-repo"),LTX_MODEL_PYTHON=sys.executable):
            self.assertNotIn("model_runtime_missing",ltx.readiness()["issues"])
        with env_values(ltx,LTX_MODEL_PYTHON=str(self.root/"missing-python")):
            self.assertIn("model_runtime_missing",ltx.readiness()["issues"])
    def test_body_limits(self):
        with env_values(ltx,LTX_MAX_BODY_BYTES="4"):
            with self.assertRaises(runtime.ServiceError) as ctx:ltx.read_request_json(Handler(body={"large":"body"}))
            self.assertEqual(ctx.exception.status,413)
        with self.assertRaises(runtime.ServiceError):ltx.read_request_json(Handler(body=[]))
    def test_admission(self):
        semaphore=threading.BoundedSemaphore(1);semaphore.acquire()
        with patch.object(ltx,"ADMISSION",semaphore),self.assertRaises(runtime.ServiceError) as ctx:
            ltx.run_generation({"prompt":"x"})
        self.assertEqual(ctx.exception.status,503)
        semaphore.release()
    def test_video_job_id_and_cleanup(self):
        with patch.object(ltx,"_run_generation",lambda p: {"jobId":p["job_id"]}):
            result=ltx.run_generation({"prompt":"x","jobId":"stable-id"})
        self.assertEqual(result["jobId"],"stable-id")
        self.assertFalse(ltx.ACTIVE_JOBS)
        self.assertTrue(list(ltx.REQUEST_ROOT.glob("*/.eulalens-complete")))
        result=ltx.build_response(ltx.OUTPUT_ROOT/"a.mp4",ltx.OUTPUT_ROOT/"results.json",30,1,{},job_id="stable-id")
        self.assertEqual(result["jobId"],"stable-id")
    def test_resident_queue_cancel_before_inference(self):
        lock=threading.Lock();lock.acquire();errors=[];ran=[]
        def run():
            try:ltx.run_generation({"prompt":"x","jobId":"queued"})
            except BaseException as exc:errors.append(exc)
        with patch.object(ltx,"GENERATION_LOCK",lock),patch.object(ltx,"resident_enabled",lambda:True),patch.object(ltx,"start_parallel_audio",lambda p:None),patch.object(ltx,"get_resident_runner",lambda:SimpleNamespace(generate=lambda *args:ran.append(True))):
            t=threading.Thread(target=run);t.start()
            try:
                deadline=time.monotonic()+2
                while "queued" not in ltx.ACTIVE_JOBS and time.monotonic()<deadline:time.sleep(.005)
                ltx.ACTIVE_JOBS["queued"]["canceled"]=True
                t.join(2)
                self.assertFalse(t.is_alive());self.assertFalse(ran)
                self.assertIsInstance(errors[0],ltx.VideoGenerationCanceled)
            finally:
                lock.release();t.join(2)
    def test_resident_step_cancel(self):
        runner=object.__new__(ltx.ResidentLTXRunner);runner.current_job_id="step"
        ltx.ACTIVE_JOBS["step"]={"canceled":False,"deadline":time.monotonic()+10}
        def original(*args,**kwargs):return kwargs["denoiser"](1)
        stage=SimpleNamespace(run=original);runner._guard_stage(stage)
        def denoiser(*args):ltx.ACTIVE_JOBS["step"]["canceled"]=True;return 1
        with self.assertRaises(ltx.VideoGenerationCanceled):stage.run(denoiser=denoiser)
    def test_subprocess_deadline(self):
        process=subprocess.Popen([sys.executable,"-c","import time; time.sleep(20)"],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,start_new_session=True)
        try:
            with self.assertRaises(runtime.ServiceError) as ctx:ltx.communicate_with_cancellation(process,None,poll_seconds=.02,timeout_seconds=.05)
            self.assertEqual(ctx.exception.status,504);self.assertIsNotNone(process.poll())
        finally:
            if process.poll() is None:runtime.terminate_group(process)
    def test_process_group_descendant_killed(self):
        child='import signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);print("ready",flush=True);time.sleep(20)'
        parent=f'import subprocess,sys,time\np=subprocess.Popen([sys.executable,"-c",{child!r}],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True)\np.stdout.readline();p.stdout.close();print(p.pid,flush=True);time.sleep(20)'
        process=subprocess.Popen([sys.executable,"-c",parent],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,start_new_session=True)
        try:
            child_pid=int(process.stdout.readline());runtime.terminate_group(process,.1)
            deadline=time.monotonic()+2
            while Path(f"/proc/{child_pid}/stat").exists() and time.monotonic()<deadline:
                if Path(f"/proc/{child_pid}/stat").read_text().split()[2]=="Z":break
                time.sleep(.01)
            stat=Path(f"/proc/{child_pid}/stat")
            self.assertTrue(not stat.exists() or stat.read_text().split()[2]=="Z")
        finally:runtime.signal_group(process,signal.SIGKILL);process.wait(timeout=2)
    def test_retention_preserves_active_and_unrelated(self):
        for name in ("old","active","unrelated"):(self.root/name).mkdir()
        marker=self.root/"old/.eulalens-complete";marker.touch();os.utime(marker,(1,1))
        runtime.prune_completed(self.root,60,10)
        self.assertFalse((self.root/"old").exists());self.assertTrue((self.root/"active").exists());self.assertTrue((self.root/"unrelated").exists())
    def test_stable_speaker_voices(self):
        voices=runtime.speaker_voices([{"speaker":"A"},{"speaker":"A"},{"speaker":"B"},{"speaker":"A"}],['one','two'])
        self.assertEqual(voices,['one','one','two','one'])
    def test_video_worker_uses_the_gpu_selected_by_its_parent(self):
        timed = load("tested_timed", "ltx-2.3/timed_ltx23_experiment.py")
        script = self.root / "request.json"
        script.write_text(json.dumps({"videos": [{"category_id": "example"}]}))
        argv = ["timed_ltx23_experiment.py", "--scripts", str(script),
                "--output-root", str(self.root), "--gpu", "0"]
        with patch.object(sys, "argv", argv), patch.object(timed, "monitor_gpu"), patch.object(timed.subprocess, "Popen") as spawn:
            spawn.return_value.wait.return_value = 0
            self.assertEqual(timed.main(), 0)
        args = spawn.call_args.args[0]
        self.assertIn("--child", args)
        self.assertEqual(args[args.index("--gpu") + 1], "0")
    def test_image_native_settings(self):
        good=image.GenerateRequest(prompt="A sufficiently long image prompt")
        image.validate_generation_settings(good)
        for fields in ({"width":1024,"height":1024},{"steps":4},{"prompt":" "*30}):
            values={"prompt":"A sufficiently long image prompt",**fields}
            with self.assertRaises(image.HTTPException):image.validate_generation_settings(image.GenerateRequest(**values))
    def test_layout_is_json_not_a_file_path(self):
        for value in ('/etc/passwd', [{'bbox':[0,1,0,float('nan')]}], [{'bbox':[1,0,0,1]}]):
            request=image.GenerateRequest(prompt='A sufficiently long image prompt',layoutBboxes=value)
            with self.assertRaises(image.HTTPException):image.validate_generation_settings(request)
        request=image.GenerateRequest(prompt='A sufficiently long image prompt',layoutBboxes='[[0,1,0,1]]')
        image.validate_generation_settings(request)
        self.assertEqual(request.layoutBboxes,[{'bbox':[0,1,0,1],'text':''}])
    def test_actual_short_subtitles_preserved(self):
        result=ltx.normalize_subtitles([{'startSeconds':0,'endSeconds':.2,'text':'a'},{'startSeconds':.3,'endSeconds':.5,'text':'b'}],1)
        self.assertEqual(result[0]['end'],.2)
        self.assertLessEqual(result[0]['end'],result[1]['start'])
    def test_launcher_environment_override(self):
        script=self.root/'serve.sh';script.write_bytes((SERVICE_ROOT/'qwen-3.5-9b/serve_qwen35_9b_vllm.sh').read_bytes())
        (self.root/'.env').write_text('HOST=0.0.0.0\nPORT=1\nCUDA_VISIBLE_DEVICES=7\nVLLM_API_KEY=test-only-key\n')
        bin_dir=self.root/'bin';bin_dir.mkdir();stub=bin_dir/'vllm'
        stub.write_text('#!/bin/sh\nprintf "%s|%s|%s\\n" "$HOST" "$PORT" "$CUDA_VISIBLE_DEVICES"\n');stub.chmod(0o700)
        env={**os.environ,'PATH':str(bin_dir)+':'+os.environ['PATH'],'HOST':'127.0.0.1','PORT':'9999','CUDA_VISIBLE_DEVICES':'3','SKIP_CUDA_CHECK':'true','HF_HOME':str(self.root/'cache')}
        result=subprocess.run(['bash',str(script)],env=env,capture_output=True,text=True,check=True)
        self.assertEqual(result.stdout.splitlines()[-1],'127.0.0.1|9999|3')
    def test_vendor_patch_is_idempotent(self):
        repo=self.root/'vendor';(repo/'models').mkdir(parents=True)
        # Tiny synthetic upstream-shaped fixture; no vendor checkout or model import.
        base = 'def generate_image(\n        callback=None,\n):\n    config = {"use_flash_attn": True,}\n    for step_idx, step_t in enumerate(tqdm.tqdm(sched.timesteps, desc="Generating")):\n        pass\n'
        target=repo/'models/pipeline.py';target.write_text(base)
        tool=SERVICE_ROOT/'hidream-o1-image-2604/apply_pipeline_patch.py'
        subprocess.run([sys.executable,str(tool),str(repo)],check=True)
        first=target.read_bytes();subprocess.run([sys.executable,str(tool),str(repo)],check=True)
        self.assertEqual(first,target.read_bytes());self.assertIn(b'cancel_check=None',first)
    def test_source_copies_match(self):
        manifest=SERVICE_ROOT/'manifest.json'
        if manifest.is_file():
            for entry in json.loads(manifest.read_text())['files']:
                self.assertEqual(hashlib.sha256((SERVICE_ROOT/entry['path']).read_bytes()).hexdigest(),entry['sha256'])
        else:
            for relative in ('service_runtime.py','ltx-2.3/ltx_video_server.py','ltx-2.3/timed_ltx23_experiment.py','ltx-2.3/kokoro_tts_worker.py','hidream-o1-image-2604/hidream_image_server.py'):
                self.assertEqual((ROOT/'scripts'/relative).read_bytes(),(ROOT/'scripts_dev'/relative).read_bytes())
    def test_audio_timeline_and_stable_gain(self):
        sr=24000;raw=b''.join(struct.pack('<h',int(8191*math.sin(2*math.pi*440*i/sr))) for i in range(sr//2))
        paths=[];lines=[]
        for i in range(7):
            path=self.root/f"line{i}.wav"
            with wave.open(str(path),'wb') as wav:wav.setnchannels(1);wav.setsampwidth(2);wav.setframerate(sr);wav.writeframes(raw)
            paths.append(path);lines.append({"start":i*4,"end":i*4+4,"text":"tone","speaker":"A"})
        target=self.root/'mix.m4a';metadata=ltx.mix_line_files(lines,paths,target,5)
        self.assertTrue(all(a['end']<=b['start'] for a,b in zip(lines,lines[1:])))
        self.assertLessEqual(lines[-1]['end'],5)
        def rms(start):
            pcm=subprocess.check_output(['ffmpeg','-v','error','-ss',str(start+.05),'-i',str(target),'-t','0.35','-ac','1','-ar','24000','-f','f32le','-'])
            samples=array.array('f');samples.frombytes(pcm);return math.sqrt(sum(x*x for x in samples)/len(samples))
        self.assertLess(abs(20*math.log10(rms(lines[0]['start'])/rms(lines[-1]['start']))),.5)
        self.assertEqual(len(metadata['subtitleLines']),7)
        with self.assertRaises(runtime.ServiceError):ltx.mix_line_files(lines,paths,self.root/'short.m4a',1)
    def test_silence_fallback_explicit(self):
        with env_values(ltx,LTX_TTS_PROVIDER='kokoro',LTX_TTS_FALLBACK_PROVIDER='flite',LTX_TTS_FALLBACK_TO_SILENCE='true'),patch.object(ltx,'synthesize_kokoro_line_files',side_effect=RuntimeError('failed')),patch.object(ltx,'synthesize_flite_line_files',side_effect=RuntimeError('failed')),patch.object(ltx,'write_silence_audio',lambda *args:None):
            result=ltx.synthesize_dialogue_audio([{'text':'x'}],self.root/'x.m4a',10,self.root)
        self.assertTrue(result['degraded']);self.assertEqual(result['mode'],'silence')
    def test_environment_overrides(self):
        self.assertEqual(ltx.HOST,'127.0.0.1')
        self.assertEqual(ltx.ENV['LTX_OUTPUT_ROOT'],os.environ['LTX_OUTPUT_ROOT'])

class AsyncImageTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        image.generation_lock=asyncio.Lock();image.registered_job_ids.clear();image.canceled_job_ids.clear();image.pending_cancellations.clear();image.job_deadlines.clear()
    async def test_cancelled_task_retains_worker_ownership(self):
        started=threading.Event();release=threading.Event();running=0;peak=0;guard=threading.Lock()
        def worker(request):
            nonlocal running,peak
            with guard:running+=1;peak=max(peak,running)
            try:
                if request.jobId=='A':started.set();release.wait(3)
                return {'ok':True}
            finally:
                with guard:running-=1
        request=lambda job:image.GenerateRequest(prompt='A sufficiently long image prompt',jobId=job)
        with patch.object(image,'generate_sync',worker):
            a=asyncio.create_task(image.generate(request('A'),AUTH));await asyncio.to_thread(started.wait,1);a.cancel()
            await asyncio.sleep(.02)
            self.assertIn('A',image.registered_job_ids);self.assertTrue(image.generation_lock.locked())
            b=asyncio.create_task(image.generate(request('B'),AUTH));await asyncio.sleep(.03)
            self.assertEqual(peak,1);release.set()
            with self.assertRaises(asyncio.CancelledError):await a
            await b
        self.assertEqual(peak,1);self.assertFalse(image.registered_job_ids)
    async def test_image_queue_deadline(self):
        await image.generation_lock.acquire()
        try:
            with patch.dict(os.environ,{'HIDREAM_REQUEST_TIMEOUT_SECONDS':'.03'}),self.assertRaises(image.HTTPException) as ctx:
                await image.generate(image.GenerateRequest(prompt='A sufficiently long image prompt'),AUTH)
            self.assertEqual(ctx.exception.status_code,504);self.assertFalse(image.registered_job_ids)
        finally:image.generation_lock.release()
    async def test_image_private_artifact_ranges(self):
        import httpx
        path=image.OUTPUT_DIR/'fixture.png';path.write_bytes(b'0123456789')
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=image.app),base_url='http://test') as client:
            response=await client.get('/outputs/fixture.png');self.assertEqual(response.status_code,401)
            response=await client.get('/outputs/fixture.png',headers={'Authorization':AUTH,'Range':'bytes=2-4'})
            self.assertEqual(response.status_code,206);self.assertEqual(response.content,b'234')
            response=await client.head('/outputs/fixture.png',headers={'Authorization':AUTH})
            self.assertEqual(response.status_code,200);self.assertEqual(response.content,b'')
        path.unlink()
    async def test_image_http_boundary(self):
        import httpx
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=image.app),base_url='http://test') as client:
            response=await client.post('/cancel',json={'jobId':'x'})
            self.assertEqual(response.status_code,401)
            with patch.dict(os.environ,{'HIDREAM_MAX_BODY_BYTES':'16'}):
                response=await client.post('/generate',headers={'Authorization':AUTH},json={'prompt':'x'*100})
                self.assertEqual(response.status_code,413)
            response=await client.get('/health');self.assertEqual(response.status_code,200)
            self.assertNotIn('modelDir',response.json())

if __name__=='__main__':
    try:unittest.main(verbosity=2)
    finally:TEMP.cleanup()
