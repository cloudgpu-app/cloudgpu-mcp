import contextlib,json,pathlib,tempfile,threading,unittest,http.server,sys,time,os
from cloudgpu import CloudGPU,CloudGPUError,private_json
class Handler(http.server.BaseHTTPRequestHandler):
    calls=[];mode='normal'
    def log_message(self,*args):pass
    def do_GET(self):self.handle_api()
    def do_POST(self):self.handle_api()
    def handle_api(self):
        body=self.rfile.read(int(self.headers.get('Content-Length','0')));body=json.loads(body) if body else None
        type(self).calls.append((self.path,self.headers.get('Authorization'),self.headers.get('Idempotency-Key'),body))
        status=200;value={}
        if self.path=='/v1/agent/connect':value={'device_code':'a'*64,'user_code':'DEMO-CODE','google_link':'https://cloudgpu.app/connect?code=DEMO-CODE','expires_in':1800,'interval':5}
        elif self.path=='/v1/agent/connect/token':value={'api_key':'fixture-secret-key','expires_at':int(time.time())+300,'key_id':'fixture-id'}
        elif self.path=='/v1/public/agent-self-check':value={'read_only':True}
        elif self.path=='/v1/gpu/account':value={'funded':self.mode!='bonus','balance_usd':5}
        elif self.path=='/v1/jobs':value={'id':'job_'+'a'*32}
        if self.mode=='error':status=403;value={'error':{'code':'account_disabled','message':'fixture-secret-key signed-secret-query'}}
        data=json.dumps(value).encode();self.send_response(status);self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
class ClientTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler);cls.thread=threading.Thread(target=cls.server.serve_forever,daemon=True);cls.thread.start();cls.base='http://127.0.0.1:'+str(cls.server.server_port)
    @classmethod
    def tearDownClass(cls):cls.server.shutdown();cls.server.server_close();cls.thread.join()
    def setUp(self):self.tmp=tempfile.TemporaryDirectory();Handler.calls=[];Handler.mode='normal';self.client=CloudGPU(api_key='fixture-key',base_url=self.base,config_dir=self.tmp.name)
    def tearDown(self):self.tmp.cleanup()
    def test_public_readiness_never_sends_an_existing_key(self):
        self.assertTrue(self.client.readiness()['read_only']);self.assertIsNone(Handler.calls[-1][1])
    def test_pending_connect_survives_restart_and_key_is_not_returned(self):
        result=self.client.connect_account('fixture agent',5);self.assertNotIn('device_code',result)
        again=CloudGPU(base_url=self.base,config_dir=self.tmp.name);result=again.finish_connect(timeout=0);self.assertNotIn('api_key',result)
        self.assertEqual((pathlib.Path(self.tmp.name)/'credentials.json').stat().st_mode&0o777,0o600)
        self.assertFalse((pathlib.Path(self.tmp.name)/'pending-connect.json').exists());self.assertEqual(again.account()['balance_usd'],5)
        elsewhere=CloudGPU(base_url='http://localhost:'+str(self.server.server_port),config_dir=self.tmp.name)
        with self.assertRaisesRegex(CloudGPUError,'connect_required'):elsewhere.account()
    def test_expired_or_cross_origin_pending_is_refused(self):
        self.client.connect_account('fixture',5)
        private_json(pathlib.Path(self.tmp.name)/'pending-connect.json',dict(base_url=self.base,until=0,device_code='a'*64,interval=5))
        with self.assertRaisesRegex(CloudGPUError,'no_pending'):self.client.finish_connect()
    def test_no_submission_without_approval_quote_budget_and_stable_key(self):
        body=dict(quote_id='fixture-quote',command='true',max_minutes=5,max_spend_usd=1)
        for args in [(None,True),('stable',False)]:
            with self.assertRaises(CloudGPUError):self.client.run_job(body,args[0],args[1])
        self.assertEqual(len(Handler.calls),0);self.client.run_job(body,'stable',True);self.assertEqual(Handler.calls[-1][2],'stable')
    def test_error_does_not_expose_response_body(self):
        Handler.mode='error'
        with self.assertRaises(CloudGPUError) as raised:self.client.account()
        self.assertEqual(str(raised.exception),'account_disabled');self.assertNotIn('secret',str(raised.exception))
    def test_bonus_balance_is_not_funding_proof(self):
        Handler.mode='bonus';self.assertFalse(self.client.wait_for_funds(1,timeout=0)['ready'])
    def test_invalid_server_origin_is_rejected_before_auth(self):
        for base in ['http://other.example','https://owner:secret@example.com','https://example.com/other','https://']:
            with self.assertRaises(CloudGPUError):CloudGPU(base_url=base)
    def test_public_credential_file_is_not_loaded(self):
        private_json(pathlib.Path(self.tmp.name)/'credentials.json',dict(base_url=self.base,api_key='fixture-private'));os.chmod(pathlib.Path(self.tmp.name)/'credentials.json',0o644)
        client=CloudGPU(base_url=self.base,config_dir=self.tmp.name)
        with self.assertRaisesRegex(CloudGPUError,'connect_required'):client.account()
if __name__=='__main__':unittest.main()
