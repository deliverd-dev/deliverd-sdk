"""Microsoft Purview from environment variables, for the command line and CI.

    DELIVERD_PURVIEW_TENANT_ID      your Entra tenant id
    DELIVERD_PURVIEW_CLIENT_ID      an Entra app with Content.Process.All
    DELIVERD_PURVIEW_CLIENT_SECRET  a secret for that app
    DELIVERD_PURVIEW_USER_ID        the Entra object id of the person using it
    DELIVERD_PURVIEW_APP_NAME       optional; how Purview names the app
    DELIVERD_PURVIEW_ON_UNAVAILABLE optional; allow, ask (the default) or deny

All four required ones, or none: with none, nothing is sent anywhere. The same
variables as the TypeScript package's MCP server.
"""

from __future__ import annotations

import os
from typing import Mapping, Optional

from .purview import PurviewCheck, Transport, entra_app_token, purview_check

_REQUIRED = ("DELIVERD_PURVIEW_TENANT_ID", "DELIVERD_PURVIEW_CLIENT_ID", "DELIVERD_PURVIEW_CLIENT_SECRET", "DELIVERD_PURVIEW_USER_ID")


def purview_from_env(env: Optional[Mapping[str, str]] = None, transport: Optional[Transport] = None) -> Optional[PurviewCheck]:
    """A Purview check from ``DELIVERD_PURVIEW_*``; None when none of them is set."""
    e = os.environ if env is None else env
    present = [k for k in _REQUIRED if (e.get(k) or "").strip()]
    if not present:
        return None
    if len(present) < len(_REQUIRED):
        missing = [k for k in _REQUIRED if k not in present]
        raise ValueError("Microsoft Purview needs all of {}; missing {}.".format(", ".join(_REQUIRED), ", ".join(missing)))
    on_unavailable = (e.get("DELIVERD_PURVIEW_ON_UNAVAILABLE") or "").strip() or "ask"
    if on_unavailable not in ("allow", "ask", "deny"):
        raise ValueError("DELIVERD_PURVIEW_ON_UNAVAILABLE is allow, ask or deny.")
    client_id = e["DELIVERD_PURVIEW_CLIENT_ID"].strip()
    return purview_check(
        token=entra_app_token(e["DELIVERD_PURVIEW_TENANT_ID"].strip(), client_id, e["DELIVERD_PURVIEW_CLIENT_SECRET"].strip(), transport),
        app={"name": (e.get("DELIVERD_PURVIEW_APP_NAME") or "").strip() or "Deliverd Screen", "entra_app_id": client_id},
        user_id=e["DELIVERD_PURVIEW_USER_ID"].strip(),
        on_unavailable=on_unavailable,
        transport=transport,
    )
