import asyncio,json,sys,pathlib,importlib.metadata,os
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]))
os.environ.update(CREWAI_TELEMETRY_OPT_OUT='true',OTEL_SDK_DISABLED='true',DO_NOT_TRACK='1',OPENAI_AGENTS_DISABLE_TRACING='1')
from cloudgpu import CloudGPU,CloudGPUError
from cloudgpu.frameworks import langchain_tools,openai_agents_tools,crewai_tools
class Recording(CloudGPU):
 def __init__(self):super().__init__(api_key='synthetic-framework-no-network-key',config_dir='/dev/shm/cloudgpu-framework-no-credentials');self.calls=[]
 def _request(self,method,path,body=None,**kwargs):self.calls.append((method,path,body,kwargs));return {'read_only':True,'method':method,'path':path}
client=Recording();report={'framework_versions':{p:importlib.metadata.version(p)for p in ['langchain-core','openai-agents','crewai']},'paid_operations':0,'checks':[]}
async def run():
 for framework,builder in [('langchain',langchain_tools),('openai_agents',openai_agents_tools),('crewai',crewai_tools)]:
  tools=builder(client);assert len(tools)==6
  def name(t):return t.name
  table={name(t):t for t in tools}
  async def invoke(tool,args):
   if framework=='langchain':return await tool.ainvoke(args)
   if framework=='openai_agents':
    from agents.tool_context import ToolContext
    return await tool.on_invoke_tool(ToolContext(context=None,tool_name=tool.name,tool_call_id='owned-acceptance',tool_arguments=json.dumps(args)),json.dumps(args))
   return await asyncio.to_thread(tool.run,**args)
  client.calls.clear();ready=await invoke(table['cloudgpu_readiness'],{});assert client.calls[-1][1]=='/v1/public/agent-self-check'
  await invoke(table['cloudgpu_task_fit'],{'task_json':'{"task_type":"gpu_environment_check"}'});assert client.calls[-1][1]=='/v1/public/task-fit'
  await invoke(table['cloudgpu_request_top_up'],{'amount_usd':5});assert client.calls[-1][1]=='/v1/billing/top-up-link'
  await invoke(table['cloudgpu_quote_compute'],{'requirements_json':'{"max_budget_usd":1}'});assert client.calls[-1][1]=='/v1/quotes'
  jid='job_'+'a'*32;await invoke(table['cloudgpu_get_job'],{'job_id':jid});assert client.calls[-1][1]=='/v1/jobs/'+jid
  before=len(client.calls)
  try:await invoke(table['cloudgpu_run_job'],{'request_json':'{"quote_id":"quote-acceptance","max_minutes":1,"max_spend_usd":1}','idempotency_key':'acceptance-stable-key','user_confirmed':False})
  except Exception:pass
  assert len(client.calls)==before,'unapproved_submission_reached_request'
  report['checks'].append({'framework':framework,'tool_schemas_constructed':6,'five_read_link_quote_tools_invoked':True,'unapproved_job_blocked_before_request':True})
 # Each framework executes the actual anonymous HTTP client, without an LLM or paid operation.
 live=CloudGPU(config_dir='/dev/shm/cloudgpu-framework-no-credentials')
 for framework,builder in [('langchain',langchain_tools),('openai_agents',openai_agents_tools),('crewai',crewai_tools)]:
  tool=builder(live)[0]
  if framework=='langchain':r=await tool.ainvoke({})
  elif framework=='openai_agents':
   from agents.tool_context import ToolContext
   r=await tool.on_invoke_tool(ToolContext(context=None,tool_name=tool.name,tool_call_id='owned-live-readiness',tool_arguments='{}'),'{}')
  else:r=await asyncio.to_thread(tool.run)
  if isinstance(r,str):
   try:r=json.loads(r)
   except ValueError:
    import ast;r=ast.literal_eval(r)
  assert r['read_only']is True;report['checks'].append({'framework':framework,'real_anonymous_http_readiness':True})
 report['status']='passed'
try:asyncio.run(run())
except Exception as e:report.update(status='failed',error_type=type(e).__name__,reason=str(e)[:300])
print(json.dumps(report))
if report['status']!='passed':sys.exit(1)
