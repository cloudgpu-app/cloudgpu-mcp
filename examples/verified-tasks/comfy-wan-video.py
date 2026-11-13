import os,pathlib,time,json,hashlib,urllib.request,urllib.error,urllib.parse,concurrent.futures,shutil,threading
_source={'modelscope_repo': 'Comfy-Org/Wan_2.1_ComfyUI_repackaged', 'files': [{'path': 'split_files/diffusion_models/wan2.1_t2v_1.3B_fp16.safetensors', 'size_bytes': 2838303560, 'sha256': 'be531024cd9018cb5b48c40cfbb6a6191645b1c792eb8bf4f8c1c6e10f924dc5', 'modelscope_revision': '462e77efa4287219475d8910e0ebb7bfb65313da'}, {'path': 'split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors', 'size_bytes': 6735906897, 'sha256': 'c3355d30191f1f066b26d93fba017ae9809dce6c627dda5f6a66eaa651204f68', 'modelscope_revision': '28eb857b47db293db0455bfba5bdefdcafa4036c'}, {'path': 'split_files/vae/wan_2.1_vae.safetensors', 'size_bytes': 253815318, 'sha256': '2fc39d31359a4b0a64f55876d8ff7fa8d780956ae2cb13463b0223e15148976b', 'modelscope_revision': '28eb857b47db293db0455bfba5bdefdcafa4036c'}], 'trusted_redirect_hosts': ['modelscope.cn'], 'all_three_independent_hashes_match': True, 'probe_http': 206, 'probe_bytes': 1048576, 'probe_seconds': 1.156, 'content_length': '1048576'}
# Owner QA only: validate the existing image before the large model transfer.
import subprocess,zipfile,io,sys
_qa_candidates=[]
for _proc in pathlib.Path('/proc').iterdir():
 if not _proc.name.isdigit():continue
 try:
  _args=(_proc/'cmdline').read_bytes().split(b'\0');_cwd=(_proc/'cwd').resolve()
  if b'main.py'in b' '.join(_args)and(_cwd/'comfy').is_dir()and(_cwd/'main.py').is_file():
   _py=pathlib.Path(os.fsdecode(_args[0]))if _args and os.path.isabs(os.fsdecode(_args[0]))and pathlib.Path(os.fsdecode(_args[0])).is_file()else(_proc/'exe').resolve();_qa_candidates.append((_cwd,_py))
 except(OSError,RuntimeError):pass
if not _qa_candidates:
 for _p in ['/root/ComfyUI','/root/autodl-tmp/ComfyUI','/workspace/ComfyUI']:
  if(pathlib.Path(_p)/'main.py').is_file():_qa_candidates.append((pathlib.Path(_p),pathlib.Path(sys.executable)));break
if not _qa_candidates:raise RuntimeError('ComfyUI image preflight failed')
_qa_cwd,_qa_python=_qa_candidates[0]
_check=subprocess.run([str(_qa_python),'-c','import torch,PIL,comfy;assert torch.cuda.is_available();print("QA_COMFY_TORCH_READY")'],cwd=str(_qa_cwd),capture_output=True,text=True,timeout=60)
if _check.returncode:raise RuntimeError('Existing ComfyUI interpreter preflight failed')
_qa_bin=pathlib.Path.cwd()/'qa-reviewed-bin';_qa_bin.mkdir(mode=0o700,exist_ok=True)
_qa_ffmpeg=_qa_bin/'ffmpeg'
if not shutil.which('ffmpeg'):
 _wheel_url='https://files.pythonhosted.org/packages/a0/2d/43c8522a2038e9d0e7dbdf3a61195ecc31ca576fb1527a528c877e87d973/imageio_ffmpeg-0.6.0-py3-none-manylinux2014_x86_64.whl'
 _wheel_url=_wheel_url.replace('https://files.pythonhosted.org/packages/','https://pypi.tuna.tsinghua.edu.cn/packages/')
 _encoder_deadline=time.monotonic()+120
 def _encoder_range(start):
  end=min(29498236,start+4*1024*1024-1);request=urllib.request.Request(_wheel_url,headers={'Range':'bytes='+str(start)+'-'+str(end)})
  with urllib.request.urlopen(request,timeout=15)as r:
   host=urllib.parse.urlsplit(r.geturl()).hostname
   if not host or not(host=='tuna.tsinghua.edu.cn'or host.endswith('.tuna.tsinghua.edu.cn'))or r.status!=206 or r.headers.get('Content-Range')!='bytes '+str(start)+'-'+str(end)+'/29498237':raise RuntimeError('Encoder range source changed')
   data=bytearray()
   while len(data)<end-start+1:
    if time.monotonic()>_encoder_deadline:raise TimeoutError('Encoder download deadline')
    chunk=r.read1(min(1024**2,end-start+1-len(data)))
    if not chunk:raise RuntimeError('Incomplete encoder range')
    data.extend(chunk)
   return bytes(data)
 with concurrent.futures.ThreadPoolExecutor(max_workers=4)as _pool:_wheel=b''.join(_pool.map(_encoder_range,range(0,29498237,4*1024*1024)))
 if len(_wheel)!=29498237 or hashlib.sha256(_wheel).hexdigest()!='c7e46fcec401dd990405049d2e2f475e2b397779df2519b544b8aab515195282':raise RuntimeError('Encoder wheel integrity failed')
 with zipfile.ZipFile(io.BytesIO(_wheel))as _z:_binary=_z.read('imageio_ffmpeg/binaries/ffmpeg-linux-x86_64-v7.0.2')
 if hashlib.sha256(_binary).hexdigest()!='e7e7fb30477f717e6f55f9180a70386c62677ef8a4d4d1a5d948f4098aa3eb99':raise RuntimeError('Encoder binary integrity failed')
 _qa_ffmpeg.write_bytes(_binary);_qa_ffmpeg.chmod(0o700);os.environ['PATH']=str(_qa_bin)+os.pathsep+os.environ.get('PATH','')
subprocess.run([shutil.which('ffmpeg'),'-version'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,check=True,timeout=10)
print('VIDEO_IMAGE_PREFLIGHT_OK '+json.dumps({'comfy_interpreter_checked':True,'cuda_available':True,'encoder_verified':True}),flush=True)

_started=time.monotonic();_deadline=_started+2700;_root=pathlib.Path.cwd()/'video-modelscope-parallel';_root.mkdir(mode=0o700,exist_ok=False);_stop=threading.Event()
_required=sum(f['size_bytes']for f in _source['files']);_fds={};_counts={};_lock=threading.Lock();_last_print={}
if shutil.disk_usage(_root).free<_required+1024**3:raise RuntimeError('insufficient_model_disk')
def _trusted(url):
 p=urllib.parse.urlsplit(url)
 return p.scheme=='https'and(p.hostname=='modelscope.cn'or(p.hostname or'').endswith('.modelscope.cn'))and p.port in(None,443)and not p.username and not p.password
class _Redirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,req,fp,code,msg,headers,url):
  if not _trusted(url):
   print('VIDEO_REJECTED_REDIRECT '+json.dumps({'host':urllib.parse.urlsplit(url).hostname,'scheme':urllib.parse.urlsplit(url).scheme}),flush=True);raise ValueError('untrusted_redirect')
  return super().redirect_request(req,fp,code,msg,headers,url)
def _range(index,entry,start,end):
 expected=end-start+1;received=0;attempt=0
 while received<expected:
  try:
   if _stop.is_set()or time.monotonic()>_deadline:raise TimeoutError()
   offset=start+received;url='https://www.modelscope.cn/api/v1/models/'+_source['modelscope_repo']+'/repo?'+urllib.parse.urlencode({'Revision':entry['modelscope_revision'],'FilePath':entry['path']})
   request=urllib.request.Request(url,headers={'User-Agent':'CloudGPU-Verified-Public-Model/1','Range':'bytes='+str(offset)+'-'+str(end)})
   with urllib.request.build_opener(_Redirect()).open(request,timeout=15)as response:
    if not _trusted(response.geturl())or response.status!=206:raise ValueError('range_response_required')
    if response.headers.get('Content-Range')!='bytes '+str(offset)+'-'+str(end)+'/'+str(entry['size_bytes']):raise ValueError('range_identity_mismatch')
    while received<expected:
     if _stop.is_set()or time.monotonic()>_deadline:raise TimeoutError()
     chunk=response.read1(min(1024**2,expected-received))
     if not chunk:raise OSError('incomplete_range')
     n=os.pwrite(_fds[index],chunk,start+received)
     if n!=len(chunk):raise OSError('partial_disk_write')
     received+=n
     with _lock:
      _counts[index]+=n;now=time.monotonic()
      if now-_last_print[index]>=20:
       print('VIDEO_MODEL_PROGRESS '+json.dumps({'source':'modelscope_parallel_range','file_index':index,'bytes':_counts[index],'elapsed_seconds':round(now-_started,3)}),flush=True);_last_print[index]=now
   if received!=expected:raise OSError('incomplete_range')
  except Exception as error:
   attempt+=1
   if attempt>=3 or isinstance(error,(ValueError,TimeoutError)):
    _stop.set();code='http_'+str(error.code)if isinstance(error,urllib.error.HTTPError)else(str(error)if isinstance(error,ValueError)else type(error).__name__)
    print('VIDEO_MODEL_FAILURE '+json.dumps({'file_index':index,'failure_code':code}),flush=True);raise RuntimeError('verified_range_download_failed')from None
jobs=[];paths=[]
try:
 for index,entry in enumerate(_source['files']):
  path=_root/'wan'/entry['path'];path.parent.mkdir(mode=0o700,parents=True,exist_ok=True);_counts[index]=0;_last_print[index]=time.monotonic();paths.append(path)
  cached=False
  for base in ['/root/ComfyUI/models','/root/autodl-tmp/ComfyUI/models','/workspace/ComfyUI/models']:
   folder=pathlib.Path(base)
   if not folder.is_dir():continue
   for candidate in list(folder.glob('**/'+path.name))[:10]:
    if not candidate.is_file()or candidate.is_symlink()or candidate.stat().st_size!=entry['size_bytes']:continue
    digest=hashlib.sha256()
    with candidate.open('rb')as stream:
     for chunk in iter(lambda:stream.read(4*1024**2),b''):digest.update(chunk)
    if digest.hexdigest()==entry['sha256']:
     shutil.copyfile(candidate,path);path.chmod(0o600);_counts[index]=entry['size_bytes'];cached=True
     print('VIDEO_PROVIDER_CACHE_MATCH '+json.dumps({'file_index':index,'bytes':entry['size_bytes'],'sha256':entry['sha256']}),flush=True);break
   if cached:break
  if cached:continue
  fd=os.open(path,os.O_RDWR|os.O_CREAT|os.O_EXCL,0o600);os.ftruncate(fd,entry['size_bytes']);_fds[index]=fd
  for start in range(0,entry['size_bytes'],128*1024**2):jobs.append((index,entry,start,min(entry['size_bytes']-1,start+128*1024**2-1)))
 with concurrent.futures.ThreadPoolExecutor(max_workers=8)as pool:list(pool.map(lambda args:_range(*args),jobs))
 for index,(entry,path)in enumerate(zip(_source['files'],paths)):
  digest=hashlib.sha256()
  with path.open('rb')as stream:
   for chunk in iter(lambda:stream.read(4*1024**2),b''):digest.update(chunk)
  if digest.hexdigest()!=entry['sha256']or _counts[index]!=entry['size_bytes']:raise RuntimeError('full_model_integrity_mismatch')
  print('VIDEO_MODEL_READY '+json.dumps({'file_index':index,'bytes':entry['size_bytes'],'sha256':entry['sha256']}),flush=True)
finally:
 for fd in _fds.values():os.close(fd)
os.environ['CLOUDGPU_MODEL_DIR']=str(_root)
print('VIDEO_ALL_MODELS_READY '+json.dumps({'bytes':_required,'seconds':round(time.monotonic()-_started,3),'independent_hashes_verified':True,'source':'modelscope_parallel_range'}),flush=True)

import os,pathlib,subprocess,time,json,urllib.request,uuid,hashlib,shutil,sys
started=time.monotonic();out=pathlib.Path(os.environ['CLOUDGPU_OUTPUT_DIR']);out.mkdir(parents=True,exist_ok=True)
modelroot=pathlib.Path(os.environ['CLOUDGPU_MODEL_DIR'])/'wan'/'split_files'
candidates=[]
for p in pathlib.Path('/proc').iterdir():
 if p.name.isdigit():
  try:
   args=(p/'cmdline').read_bytes().split(b'\0');cwd=(p/'cwd').resolve()
   if b'main.py' in b' '.join(args) and (cwd/'comfy').is_dir() and (cwd/'main.py').is_file():candidates.append((cwd,pathlib.Path(os.fsdecode(args[0])) if args and os.path.isabs(os.fsdecode(args[0])) and pathlib.Path(os.fsdecode(args[0])).is_file() else (p/'exe').resolve()))
  except (OSError,RuntimeError):pass
for p in ['/root/ComfyUI','/root/autodl-tmp/ComfyUI','/workspace/ComfyUI']:
 root=pathlib.Path(p)
 if (root/'main.py').is_file() and not candidates:candidates.append((root,pathlib.Path(sys.executable)))
if not candidates:raise RuntimeError('Reviewed ComfyUI installation missing; no remote installation performed')
root,python=candidates[0]
ffmpeg=shutil.which('ffmpeg')
if not ffmpeg:
 result=subprocess.run([str(python),'-c','import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())'],capture_output=True,text=True,timeout=10)
 if result.returncode==0 and pathlib.Path(result.stdout.strip()).is_file():ffmpeg=result.stdout.strip()
if not ffmpeg:raise RuntimeError('MP4 encoder missing; no unreviewed software installed')
work=pathlib.Path.cwd()/'comfy-video-acceptance';work.mkdir(mode=0o700,exist_ok=True)
config=work/'models.yaml';config.write_text('acceptance:\n  base_path: '+str(modelroot)+'\n  diffusion_models: diffusion_models\n  text_encoders: text_encoders\n  vae: vae\n')
client=urllib.request.build_opener(urllib.request.ProxyHandler({}));base='http://127.0.0.1:8189'
def request(path,body=None,limit=16*1024*1024):
 data=None if body is None else json.dumps(body).encode()
 with client.open(urllib.request.Request(base+path,data=data,headers={'Content-Type':'application/json'}),timeout=20) as r:
  value=r.read(limit+1)
  if len(value)>limit:raise RuntimeError('Application response exceeds bound')
  return json.loads(value)
log=(work/'server.log').open('wb')
proc=subprocess.Popen([str(python),str(root/'main.py'),'--listen','127.0.0.1','--port','8189','--extra-model-paths-config',str(config),'--output-directory',str(work/'frames'),'--disable-auto-launch'],cwd=str(root),stdout=log,stderr=log)
try:
 deadline=time.monotonic()+150
 while True:
  if proc.poll() is not None:raise RuntimeError('Isolated ComfyUI process exited during startup')
  try:info=request('/object_info');break
  except (OSError,ValueError):
   if time.monotonic()>deadline:raise RuntimeError('Isolated ComfyUI startup deadline')
   time.sleep(2)
 graph={
 '1':{'class_type':'UNETLoader','inputs':{'unet_name':'wan2.1_t2v_1.3B_fp16.safetensors','weight_dtype':'default'}},
 '2':{'class_type':'CLIPLoader','inputs':{'clip_name':'umt5_xxl_fp8_e4m3fn_scaled.safetensors','type':'wan','device':'default'}},
 '3':{'class_type':'VAELoader','inputs':{'vae_name':'wan_2.1_vae.safetensors'}},
 '4':{'class_type':'CLIPTextEncode','inputs':{'text':'A small paper boat floating gently on a calm lake, daylight, peaceful landscape','clip':['2',0]}},
 '5':{'class_type':'CLIPTextEncode','inputs':{'text':'blurry, low quality, text, watermark','clip':['2',0]}},
 '6':{'class_type':'EmptyHunyuanLatentVideo','inputs':{'width':256,'height':256,'length':17,'batch_size':1}},
 '7':{'class_type':'ModelSamplingSD3','inputs':{'model':['1',0],'shift':8.0}},
 '8':{'class_type':'KSampler','inputs':{'model':['7',0],'positive':['4',0],'negative':['5',0],'latent_image':['6',0],'seed':20261113,'steps':8,'cfg':5.0,'sampler_name':'euler','scheduler':'simple','denoise':1.0}},
 '9':{'class_type':'VAEDecode','inputs':{'samples':['8',0],'vae':['3',0]}},
 '10':{'class_type':'SaveImage','inputs':{'images':['9',0],'filename_prefix':'acceptance_video'}}}
 for node in graph.values():
  if node['class_type'] not in info:raise RuntimeError('Required reviewed core node unavailable: '+node['class_type'])
  schema=info[node['class_type']]['input']
  if any(k not in node['inputs'] for k in schema.get('required',{})):raise RuntimeError('Required node input changed')
  for key,value in node['inputs'].items():
   rule=schema.get('required',{}).get(key) or schema.get('optional',{}).get(key)
   if not rule:raise RuntimeError('Unknown core input')
   if isinstance(rule[0],list) and value not in rule[0]:raise RuntimeError('Model or enum missing from isolated model paths')
 queued=request('/prompt',{'prompt':graph,'client_id':uuid.uuid4().hex});pid=queued.get('prompt_id')
 if not pid or queued.get('node_errors'):raise RuntimeError('Reviewed video workflow was not accepted')
 deadline=time.monotonic()+300
 while True:
  history=request('/history/'+pid).get(pid)
  if history:
   status=history.get('status',{})
   if status.get('status_str')=='error':raise RuntimeError('ComfyUI video workflow failed')
   if status.get('completed') is True:break
  if time.monotonic()>deadline:raise RuntimeError('Video generation deadline')
  time.sleep(2)
 images=history.get('outputs',{}).get('10',{}).get('images',[])
 if len(images)!=17:raise RuntimeError('Expected exactly 17 video frames')
 # Encode only files listed by this unique prompt; never collect arbitrary GPU files.
 frame_dir=work/'encode';frame_dir.mkdir(mode=0o700)
 for i,image in enumerate(images):
  import urllib.parse
  query=urllib.parse.urlencode({'filename':image['filename'],'subfolder':image.get('subfolder',''),'type':'output'})
  with client.open(base+'/view?'+query,timeout=20) as r:data=r.read(4*1024*1024+1)
  if len(data)>4*1024*1024 or not data.startswith(b'\x89PNG\r\n\x1a\n'):raise RuntimeError('Invalid generated frame')
  (frame_dir/('%04d.png'%i)).write_bytes(data)
 subprocess.run([ffmpeg,'-v','error','-y','-framerate','8','-i',str(frame_dir/'%04d.png'),'-c:v','libx264','-pix_fmt','yuv420p',str(out/'video.mp4')],check=True,timeout=60)
 video=out/'video.mp4'
 if not 0<video.stat().st_size<100*1024*1024:raise RuntimeError('Video output bound failed')
 summary={'status':'passed','task':'comfyui_wan_video','width':256,'height':256,'frames':17,'fps':8,'steps':8,'seed':20261113,'generation_startup_encode_seconds':round(time.monotonic()-started,6),'video_bytes':video.stat().st_size,'sha256':hashlib.sha256(video.read_bytes()).hexdigest(),'scope':'Tiny synthetic video smoke test; not a quality benchmark or customer browser recovery validation'}
 (out/'video-acceptance.json').write_text(json.dumps(summary));print('COMFY_VIDEO_ACCEPTANCE_OK '+json.dumps(summary))
finally:
 proc.terminate()
 try:proc.wait(timeout=15)
 except subprocess.TimeoutExpired:proc.kill();proc.wait(timeout=5)
 log.close()
