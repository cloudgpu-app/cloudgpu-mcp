"""No dependencies, background GPU pool, automatic payment or blind Job retry."""
import hashlib,json,os,pathlib,re,stat,tempfile,time,urllib.error,urllib.parse,urllib.request

class CloudGPUError(RuntimeError):
    def __init__(self,code,status=None):
        self.code,self.status=code,status
        super().__init__(code)  # Never include response bodies, keys or signed URLs.

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):raise CloudGPUError('redirect_refused')

def private_text(path,text):
    path=pathlib.Path(path);path.parent.mkdir(parents=True,mode=0o700,exist_ok=True)
    info=path.parent.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_mode&0o077 or (hasattr(os,'getuid') and info.st_uid!=os.getuid()):raise CloudGPUError('private_directory_required')
    fd,name=tempfile.mkstemp(prefix='.cloudgpu-',dir=path.parent)
    try:
        os.fchmod(fd,0o600)
        with os.fdopen(fd,'w') as f:f.write(text)
        os.replace(name,path)
    finally:
        if os.path.exists(name):os.unlink(name)

def private_json(path,data):private_text(path,json.dumps(data))

def read_private(path):
    try:
        path=pathlib.Path(path);info=path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_mode&0o077 or info.st_size>65536 or (hasattr(os,'getuid') and info.st_uid!=os.getuid()):return None
        with path.open() as f:return json.load(f)
    except (OSError,ValueError):return None

class CloudGPU:
    def __init__(self,api_key=None,base_url=None,config_dir=None):
        self.base_url=(base_url or os.environ.get('CLOUDGPU_BASE_URL') or 'https://cloudgpu.app').rstrip('/')
        if self.base_url.endswith('/v1'):self.base_url=self.base_url[:-3]
        u=urllib.parse.urlsplit(self.base_url)
        if not u.hostname or u.username or u.password or u.query or u.fragment or u.path or (u.scheme!='https' and not(u.scheme=='http' and u.hostname in ('127.0.0.1','localhost'))):raise CloudGPUError('invalid_server_origin')
        self.config_dir=pathlib.Path(config_dir or os.environ.get('CLOUDGPU_CONFIG_DIR') or pathlib.Path.home()/'.config/cloudgpu')
        stored=read_private(self.config_dir/'credentials.json') or {}
        valid=stored.get('base_url')==self.base_url and (not stored.get('expires_at') or float(stored['expires_at'])>time.time())
        self._key=api_key or os.environ.get('CLOUDGPU_API_KEY') or (stored.get('api_key') if valid else None)
        self._opener=urllib.request.build_opener(NoRedirect())
    def _request(self,method,path,body=None,anonymous=False,idempotency_key=None):
        if not path.startswith('/v1/') or '?' in path or '#' in path:raise CloudGPUError('invalid_api_path')
        headers={'Content-Type':'application/json','User-Agent':'cloudgpu-python/0.1.0'}
        if not anonymous:
            if not self._key:raise CloudGPUError('connect_required')
            headers['Authorization']='Bearer '+self._key
        if idempotency_key:headers['Idempotency-Key']=idempotency_key
        req=urllib.request.Request(self.base_url+path,data=None if body is None else json.dumps(body,allow_nan=False).encode(),headers=headers,method=method)
        try:
            with self._opener.open(req,timeout=30) as response:data=response.read(262145)
        except urllib.error.HTTPError as e:
            try:body=json.loads(e.read(65536));code=body.get('error',{}).get('code','request_rejected')
            except (ValueError,AttributeError):code='request_rejected'
            if not isinstance(code,str) or not re.fullmatch(r'[a-z_]{1,80}',code):code='request_rejected'
            raise CloudGPUError(code,e.code) from None
        except OSError:raise CloudGPUError('network_error_reconcile_before_retry') from None
        if len(data)>262144:raise CloudGPUError('response_too_large')
        try:return json.loads(data)
        except ValueError:raise CloudGPUError('invalid_response') from None
    def readiness(self):return self._request('GET','/v1/public/agent-self-check',anonymous=True)
    def task_fit(self,**task):return self._request('POST','/v1/public/task-fit',task,anonymous=True)
    def account(self):return self._request('GET','/v1/gpu/account')
    def request_top_up(self,amount_usd):return self._request('POST','/v1/billing/top-up-link',{'amount_usd':amount_usd})
    def wait_for_funds(self,min_balance_usd,timeout=60):
        minimum=float(min_balance_usd)
        if not 0<minimum<=10000 or not 0<=timeout<=60:raise CloudGPUError('invalid_funding_limits')
        deadline=time.monotonic()+timeout
        while True:
            account=self.account()
            if account.get('funded') is True and float(account['balance_usd'])>=minimum:return {'ready':True,'account':account}
            if time.monotonic()>=deadline:return {'ready':False,'account':account}
            time.sleep(min(5,max(0,deadline-time.monotonic())))
    def connect_account(self,agent_name,spend_limit_usd,max_concurrent=1,expires_in_days=30):
        if not isinstance(agent_name,str) or not 1<=len(agent_name)<=64 or not 1<=float(spend_limit_usd)<=10000 or not 1<=max_concurrent<=10 or not 1<=expires_in_days<=90:raise CloudGPUError('invalid_connect_limits')
        r=self._request('POST','/v1/agent/connect',dict(agent_name=agent_name,spend_limit_usd=spend_limit_usd,max_concurrent=max_concurrent,expires_in_days=expires_in_days),anonymous=True)
        if not re.fullmatch(r'[a-f0-9]{64}',r.get('device_code','')):raise CloudGPUError('invalid_device_response')
        private_json(self.config_dir/'pending-connect.json',dict(device_code=r['device_code'],base_url=self.base_url,until=time.time()*1000+min(1800,float(r['expires_in']))*1000,interval=max(5,float(r.get('interval',5)))))
        return {k:r[k] for k in ['google_link','verification_uri_complete','user_code','expires_in'] if k in r}
    def finish_connect(self,timeout=60):
        if not 0<=timeout<=60:raise CloudGPUError('invalid_connect_timeout')
        pending=read_private(self.config_dir/'pending-connect.json') or {}
        if pending.get('base_url')!=self.base_url or not time.time()*1000<pending.get('until',0)<=time.time()*1000+1801000:raise CloudGPUError('no_pending_connect')
        deadline=min(time.monotonic()+timeout,time.monotonic()+pending['until']/1000-time.time())
        while True:
            try:
                cred=self._request('POST','/v1/agent/connect/token',{'device_code':pending['device_code']},anonymous=True)
                if not isinstance(cred.get('api_key'),str) or not cred['api_key']:raise CloudGPUError('invalid_credential_response')
                private_json(self.config_dir/'credentials.json',{**cred,'base_url':self.base_url})
                self._key=cred['api_key'];(self.config_dir/'pending-connect.json').unlink()
                return {'connected':True,**{k:cred[k] for k in ['key_id','agent_name','spend_limit_usd','max_concurrent','expires_at'] if k in cred}}
            except CloudGPUError as e:
                if e.code not in ('authorization_pending','slow_down'):raise
                if time.monotonic()>=deadline:return {'connected':False,'pending':True}
                time.sleep(min(max(5,pending['interval']),max(0,deadline-time.monotonic())))
    def quote(self,**requirements):return self._request('POST','/v1/quotes',requirements,anonymous=not bool(self._key))
    def get_job(self,job_id):
        if not re.fullmatch(r'job_[a-f0-9]{32}',job_id):raise CloudGPUError('invalid_job_id')
        return self._request('GET','/v1/jobs/'+job_id)
    def run_job(self,request,idempotency_key,user_confirmed=False):
        if user_confirmed is not True or not re.fullmatch(r'[A-Za-z0-9._:-]{1,128}',idempotency_key or ''):raise CloudGPUError('explicit_approval_and_idempotency_required')
        if not isinstance(request.get('quote_id'),str) or not request.get('quote_id') or not 1<=int(request.get('max_minutes',0))<=1440 or not 0<float(request.get('max_spend_usd',0))<=10000:raise CloudGPUError('quote_and_bounds_required')
        return self._request('POST','/v1/jobs',request,idempotency_key=idempotency_key)
