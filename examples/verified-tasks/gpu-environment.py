import datetime,json,os,pathlib,platform,subprocess,time
started=time.monotonic()
r=subprocess.run(['nvidia-smi','--query-gpu=name,memory.total,driver_version','--format=csv,noheader'],text=True,capture_output=True,timeout=20)
if r.returncode or not r.stdout.strip():raise RuntimeError('GPU driver check failed')
out={'case':'gpu_environment_check','status':'passed','utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'gpu':r.stdout.strip().splitlines(),'python':platform.python_version(),'elapsed_seconds':round(time.monotonic()-started,6),'scope':'NVIDIA driver and device visibility; not a model inference benchmark'}
p=pathlib.Path(os.environ['CLOUDGPU_OUTPUT_DIR']);p.mkdir(mode=0o700,parents=True,exist_ok=True);(p/'environment-check.json').write_text(json.dumps(out));print('GPU_ENVIRONMENT_ACCEPTANCE_OK '+json.dumps(out))
