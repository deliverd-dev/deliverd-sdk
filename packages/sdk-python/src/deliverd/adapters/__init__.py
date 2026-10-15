"""Deliverd inside the agent frameworks people already use: a person approves a
tool call from their inbox, Slack or Teams, and the agent carries on.

- :mod:`deliverd.adapters.agent_framework` — Microsoft Agent Framework's
  ``function_approval_request``, for ``@tool(approval_mode="always_require")``
  and MCP tools.
- :mod:`deliverd.adapters.foundry` — Microsoft Foundry Agent Service's
  ``mcp_approval_request``, for an MCP tool with ``require_approval``.

The Python half of ``@deliverd/sdk/adapters``. No dependencies: each adapter
reads its framework's objects by shape, and importing one imports nothing from
the framework. Each tool call is one request keyed by its call id, so a retried
round does not ask twice.
"""

from ._shared import DEFAULT_TOOL_EXPIRY, CallDescription, Resolution, default_description

__all__ = ["CallDescription", "Resolution", "default_description", "DEFAULT_TOOL_EXPIRY"]
