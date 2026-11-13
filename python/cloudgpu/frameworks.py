"""Optional adapters. The underlying SDK still enforces approval/quote/idempotency."""
def langchain_tools(client):
    from langchain_core.tools import StructuredTool
    return [StructuredTool.from_function(client.readiness,name='cloudgpu_readiness',description='Read real compute capabilities, billing and known limits without spending.'),StructuredTool.from_function(client.request_top_up,name='cloudgpu_request_top_up',description='Create an owner payment link only. Never charges a card or submits work.')]

def openai_agents_tools(client):
    from agents import function_tool
    @function_tool
    def cloudgpu_readiness()->dict:
        """Read capabilities and limits without spending."""
        return client.readiness()
    @function_tool
    def cloudgpu_request_top_up(amount_usd:float)->dict:
        """Create a payment link for the owner, without performing payment."""
        return client.request_top_up(amount_usd)
    return [cloudgpu_readiness,cloudgpu_request_top_up]

def crewai_tools(client):
    from crewai.tools import tool
    @tool('cloudgpu_readiness')
    def readiness()->dict:
        """Read compute capabilities and known limits; never rent a GPU."""
        return client.readiness()
    @tool('cloudgpu_request_top_up')
    def request_top_up(amount_usd:float)->dict:
        """Create a human-only payment link; never pays or rents."""
        return client.request_top_up(amount_usd)
    return [readiness,request_top_up]
