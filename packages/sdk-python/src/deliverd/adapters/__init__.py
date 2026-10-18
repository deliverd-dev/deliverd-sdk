"""Deliverd inside the agent frameworks people already use: a person approves a
tool call from their inbox, Slack or Teams, and the agent carries on.

- :mod:`deliverd.adapters.agent_framework` — Microsoft Agent Framework's
  ``function_approval_request``, for ``@tool(approval_mode="always_require")``
  and MCP tools.
- :mod:`deliverd.adapters.foundry` — Microsoft Foundry Agent Service's
  ``mcp_approval_request``, for an MCP tool with ``require_approval``.
- :mod:`deliverd.adapters.pydantic_ai` — Pydantic AI's deferred tools, for
  ``requires_approval=True``: a ``HandleDeferredToolCalls`` capability that
  answers them inside the run.
- :mod:`deliverd.adapters.crewai` — CrewAI's before and after tool-call hooks,
  which hold a call until a person decides and tell the agent why it did not run.
- :mod:`deliverd.adapters.muse_spark` — the function calls in a Muse Spark
  response from Meta's Model API, over the Responses or Chat Completions API:
  only the approved ones run, and every call gets an output the API accepts.
- :mod:`deliverd.adapters.bedrock` — Amazon Bedrock Agents' return of control,
  for action group functions with user confirmation on, answered on the session.
- :mod:`deliverd.adapters.strands` — Strands Agents' before-tool-call hook, for
  agents on Amazon Bedrock AgentCore and anywhere else Strands runs.
- :mod:`deliverd.adapters.adk` — Google ADK's ``before_tool_callback``, and its
  ``adk_request_confirmation`` answered for an agent on Vertex AI Agent Engine.

The Python half of ``@deliverd/sdk/adapters``. No dependencies: each adapter
reads its framework's objects by shape, and importing one imports nothing from
the framework. Each tool call is one request keyed by its call id — or, in
CrewAI, which gives a call no id, by its task and input, and in Bedrock by its
return of control and place there — so a retried round does not ask twice.
"""

from ._shared import DEFAULT_TOOL_EXPIRY, CallDescription, Resolution, default_description

__all__ = ["CallDescription", "Resolution", "default_description", "DEFAULT_TOOL_EXPIRY"]
