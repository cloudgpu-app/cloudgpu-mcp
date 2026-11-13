"""Optional adapters; the SDK enforces quote, approval and idempotency at runtime."""
import json

def tool_functions(client):
    def cloudgpu_readiness()->dict:
        """Read real compute capabilities, billing, evidence and known limits; no spending."""
        return client.readiness()
    def cloudgpu_task_fit(task_json:str)->dict:
        """Assess a JSON task description without submitting work or spending money."""
        return client.task_fit(**json.loads(task_json))
    def cloudgpu_request_top_up(amount_usd:float)->dict:
        """Create a human payment link only. Never pays, approves a quote or rents a GPU."""
        return client.request_top_up(amount_usd)
    def cloudgpu_quote_compute(requirements_json:str)->dict:
        """Quote exact JSON Job requirements; check supports_jobs and get owner approval. No GPU created."""
        return client.quote(**json.loads(requirements_json))
    def cloudgpu_get_job(job_id:str)->dict:
        """Read an owned Job to reconcile its state, persisted outputs and release before any retry."""
        return client.get_job(job_id)
    def cloudgpu_run_job(request_json:str,idempotency_key:str,user_confirmed:bool=False)->dict:
        """Submit one exact, owner-approved bounded Job with quote and stable key. Never infer approval or retry automatically."""
        return client.run_job(json.loads(request_json),idempotency_key,user_confirmed)
    return [cloudgpu_readiness,cloudgpu_task_fit,cloudgpu_request_top_up,cloudgpu_quote_compute,cloudgpu_get_job,cloudgpu_run_job]

def langchain_tools(client):
    from langchain_core.tools import StructuredTool
    return [StructuredTool.from_function(f,name=f.__name__,description=f.__doc__) for f in tool_functions(client)]

def openai_agents_tools(client):
    from agents import function_tool
    return [function_tool(f) for f in tool_functions(client)]

def crewai_tools(client):
    from crewai.tools import tool
    return [tool(f.__name__)(f) for f in tool_functions(client)]
