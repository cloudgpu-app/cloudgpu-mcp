import os, pathlib, subprocess, sys

report={'pipeline_sha256':options['pipeline_sha256'],'state':'running','steps':[]}
fd=None
if options['persist_summary']:
    root=os.environ.get('CLOUDGPU_OUTPUT_DIR')
    if not root: raise RuntimeError('Explicit output collection directory is required')
    target=pathlib.Path(root)/'pipeline-summary.json'
    fd=os.open(str(target),os.O_WRONLY|os.O_CREAT|os.O_EXCL|getattr(os,'O_NOFOLLOW',0),0o600)

def record():
    if fd is not None:
        data=json.dumps(report,sort_keys=True).encode('utf-8')
        os.lseek(fd,0,os.SEEK_SET)
        os.ftruncate(fd,0)
        view=memoryview(data)
        while view:
            written=os.write(fd,view)
            if written<=0: raise RuntimeError('Summary could not be recorded')
            view=view[written:]
        os.fsync(fd)

exit_code=0
try:
    record()
    for step in options['steps']:
        result=subprocess.run(['bash','-e','-o','pipefail','-c',step['command']],check=False)
        report['steps'].append({'id':step['id'],'exit_code':result.returncode})
        if result.returncode:
            report['state']='failed'
            exit_code=result.returncode if 0<result.returncode<256 else 1
            record()
            break
        record()
    else:
        report['state']='succeeded'
        record()
finally:
    if fd is not None: os.close(fd)
print(json.dumps(report,sort_keys=True))
sys.exit(exit_code)
