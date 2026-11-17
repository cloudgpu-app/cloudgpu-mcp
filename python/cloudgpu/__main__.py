import argparse,json,os,pathlib,re,time
from . import CloudGPU,CloudGPUError,private_text,read_private

def hermes_env(client):
    # Only on explicit --hermes. Store locally; never echo the key.
    home=pathlib.Path(os.environ.get('HERMES_HOME',str(pathlib.Path.home()/'.hermes'))).expanduser()
    path=home/'.env'
    path.parent.mkdir(parents=True,mode=0o700,exist_ok=True)
    if path.is_symlink():raise CloudGPUError('hermes_env_symlink_refused')
    value=client._key
    if not re.fullmatch(r'[A-Za-z0-9_.-]{10,512}',value or ''):raise CloudGPUError('invalid_credential_response')
    original=path.read_text() if path.exists() else ''
    if len(original)>1024*1024:raise CloudGPUError('hermes_env_too_large')
    content='\n'.join(line for line in original.splitlines() if not re.match(r'\s*(?:export\s+)?CLOUDGPU_(?:API_KEY|BASE_URL)\s*=',line))
    content+='\nCLOUDGPU_API_KEY='+value+'\nCLOUDGPU_BASE_URL='+client.base_url+'/v1\n'
    private_text(path,content)

def main():
    parser=argparse.ArgumentParser(description='Owner-approved CloudGPU connection; never prints keys.')
    commands=parser.add_subparsers(dest='command',required=True)
    commands.add_parser('check')
    connect=commands.add_parser('connect');connect.add_argument('--name',default='Python/Hermes agent');connect.add_argument('--spend-limit',type=float,required=True);connect.add_argument('--hermes',action='store_true')
    args=parser.parse_args()
    try:
        client=CloudGPU()
        if args.command=='check':print(json.dumps(client.readiness()));return
        pending=read_private(client.config_dir/'pending-connect.json') or {}
        if pending.get('base_url')==client.base_url and time.time()*1000<pending.get('until',0)<=time.time()*1000+1801000:print('Resuming pending approval; reopen your previous CloudGPU connect link.',flush=True)
        else:
            result=client.connect_account(args.name,args.spend_limit)
            print('Open this link to sign in, review the limit and approve:',flush=True);print(result.get('google_link') or result['verification_uri_complete'],flush=True)
        while True:
            result=client.finish_connect()
            if not result.get('pending'):break
        if args.hermes:hermes_env(client)
        print('Connected. Your agent can continue now. No key was printed.',flush=True)
    except CloudGPUError as error:parser.exit(1,'CloudGPU: '+error.code+'\n')
if __name__=='__main__':main()
