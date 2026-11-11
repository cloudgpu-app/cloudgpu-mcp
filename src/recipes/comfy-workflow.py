import hashlib,json,os,pathlib,re,time,urllib.request,urllib.parse,uuid

def run(options, project_file, output_dir):
    path=project_file(options['workflow_path'],2097152)
    workflow=json.loads(path.read_text(encoding='utf-8'))
    if not isinstance(workflow,dict) or not 1<=len(workflow)<=128:
        raise ValueError('Use a bounded ComfyUI API-format workflow')
    if any(not isinstance(n,dict) or not isinstance(n.get('class_type'),str) or not isinstance(n.get('inputs'),dict) for n in workflow.values()):
        raise ValueError('Export the workflow in API format')
    # Only the already selected instance's loopback application; never follow redirects.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self,*args,**kwargs):
            raise ValueError('Application redirect refused')
    client=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect)
    origin='http://127.0.0.1:'+str(options['comfy_port'])
    deadline=time.monotonic()+options['timeout_seconds']
    def request(path,body=None,limit=1048576):
        remaining=deadline-time.monotonic()
        if remaining<=0: raise TimeoutError('Application deadline reached')
        req=urllib.request.Request(origin+path,data=None if body is None else json.dumps(body).encode(),headers={'Content-Type':'application/json'})
        with client.open(req,timeout=min(15,remaining)) as response:
            if response.status!=200: raise ValueError('Application request failed')
            data=response.read(limit+1)
            if len(data)>limit: raise ValueError('Application response exceeds limit')
            return data
    stats=json.loads(request('/system_stats'))
    if not isinstance(stats,dict) or not isinstance(stats.get('system'),dict) or not isinstance(stats.get('devices'),list):
        raise ValueError('ComfyUI readiness not confirmed')
    # One submission only. An uncertain POST is not an excuse to submit a second prompt.
    queued=json.loads(request('/prompt',{'prompt':workflow,'client_id':uuid.uuid4().hex}))
    prompt=queued.get('prompt_id')
    if queued.get('node_errors') or not isinstance(prompt,str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,80}',prompt):
        raise ValueError('Workflow was not accepted')
    while True:
        history=json.loads(request('/history/'+urllib.parse.quote(prompt,safe='')))
        result=history.get(prompt) if isinstance(history,dict) else None
        if result:
            status=result.get('status',{})
            if status.get('status_str')=='error': raise ValueError('Workflow execution failed')
            if status.get('completed') is True: break
        if deadline-time.monotonic()<=1: raise TimeoutError('Application deadline reached')
        time.sleep(min(1,deadline-time.monotonic()))
    images=[]
    for node in (result.get('outputs') or {}).values():
        images.extend(node.get('images',[]) if isinstance(node,dict) else [])
    if len(images)!=options['image_count']:
        raise ValueError('Workflow output count differs from the reviewed task')
    manifest=[]
    for i,image in enumerate(images):
        filename=image.get('filename','');subfolder=image.get('subfolder','')
        if image.get('type')!='output' or not re.fullmatch(r'[A-Za-z0-9_.-]+[.]png',filename) or filename.startswith('.'):
            raise ValueError('Only explicit generated PNG outputs are supported')
        if subfolder and (not re.fullmatch(r'[A-Za-z0-9_/-]+',subfolder) or any(p in ('','.','..') for p in subfolder.split('/'))):
            raise ValueError('Unsafe application output path')
        data=request('/view?'+urllib.parse.urlencode({'filename':filename,'subfolder':subfolder,'type':'output'}),limit=options['image_max_bytes'])
        if not data.startswith(b'\x89PNG\r\n\x1a\n'): raise ValueError('Application output is not PNG data')
        name='image-'+str(i)+'.png'
        with (output_dir/name).open('xb') as f: f.write(data)
        manifest.append({'file':name,'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()})
    return {'task':'comfyui-workflow','image_count':len(manifest),'files':manifest}
