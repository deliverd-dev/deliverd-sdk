"""Deliverd inside the agent frameworks people already use: a person approves a
tool call from their inbox, Slack or Teams, and the agent carries on.

- :mod:`deliverd.adapters.managed_agents` — Claude Managed Agents, hosted or
  self-hosted: the tool calls a permission policy holds for confirmation,
  answered with ``user.tool_confirmation``.
- :mod:`deliverd.adapters.antigravity` — Google Antigravity's SDK: a
  pre-tool-call decide hook, or an ``ask_user`` policy handler, that holds a
  call until a person decides.
- :mod:`deliverd.adapters.openai_agents` — the OpenAI Agents SDK's approval
  interruptions, for ``@function_tool(needs_approval=True)``: approved or
  rejected on the run's state, and the run resumed.
- :mod:`deliverd.adapters.claude_agent_sdk` — the Claude Agent SDK's
  ``can_use_tool`` callback, which holds a call until a person decides.
- :mod:`deliverd.adapters.agent_framework` — Microsoft Agent Framework's
  ``function_approval_request``, for ``@tool(approval_mode="always_require")``
  and MCP tools.
- :mod:`deliverd.adapters.foundry` — Microsoft Foundry Agent Service's
  ``mcp_approval_request``, for an MCP tool with ``require_approval``.
- :mod:`deliverd.adapters.perplexity` — Perplexity's Agent API: the
  ``mcp_approval_request`` items from MCP servers and connectors with
  ``require_approval``, and the function calls your code runs.
- :mod:`deliverd.adapters.pydantic_ai` — Pydantic AI's deferred tools, for
  ``requires_approval=True``: a ``HandleDeferredToolCalls`` capability that
  answers them inside the run.
- :mod:`deliverd.adapters.crewai` — CrewAI's before and after tool-call hooks,
  which hold a call until a person decides and tell the agent why it did not run.
- :mod:`deliverd.adapters.muse_spark` — the function calls in a Muse Spark
  response from Meta's Model API, over the Responses or Chat Completions API:
  only the approved ones run, and every call gets an output the API accepts.
  The same works for Llama models served by Llama Stack's OpenAI-compatible
  Responses endpoint.
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
