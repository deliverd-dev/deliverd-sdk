"""Microsoft Purview's answer on a text, held beside Deliverd's own.

::

    purview = purview_check(
        token=lambda: credential.get_token("https://graph.microsoft.com/.default").token,
        user_id=entra_object_id_of_the_user,
        app={"name": "Claims assistant", "entra_app_id": "11111111-…"},
    )
    screened = deliverd.screen(prompt, ai_system_id=CLAIMS_MODEL, purview=purview)

The Python half of ``packages/core/src/purview.ts``, rule for rule. The call
goes from where your agent runs straight to Microsoft Graph
(``processContent``), with your own Entra app's token, so the text goes to
Microsoft and never to Deliverd. Deliverd is sent only the outcome:

- ``block``: nothing is sent. The organisation's own policy said so, and it is
  honoured on every plan, report-only included.
- ``warn``: a person decides, through an ordinary approval, so the override
  Purview allows is recorded, with who made it.
- ``audit``: no hold. Purview has recorded the activity itself.

The Entra app needs ``Content.Process.User`` or ``Content.Process.All``
(application permission with ``user_id``, or delegated with the signed-in
user's token and no ``user_id``). Purview applies DLP policies to an
Entra-registered app only when they were created with ``New-DlpComplianceRule``;
one made in the portal alone does not apply.
"""

from __future__ import annotations

import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Mapping, Optional, Tuple, Union

PURVIEW_RESTRICTIONS = ("audit", "warn", "block")
_RESTRICTION_RANK = {"audit": 0, "warn": 1, "block": 2}
_VERDICT_RANK = {"allow": 0, "redact": 1, "ask": 2, "deny": 3}
_GRAPH = "https://graph.microsoft.com/v1.0"
_GUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.IGNORECASE)


@dataclass
class PurviewOutcome:
    """What Deliverd is sent: never the text, only Purview's answer on it."""

    #: The strictest restriction among Purview's policy actions; ``None`` when there were none.
    restriction: Optional[str]
    #: How many policy actions Purview returned.
    actions: int = 0
    #: Purview said the organisation's policies changed since the caller last looked.
    scope_modified: bool = False
    #: Purview could not be reached; ``restriction`` is what the caller chose for that case.
    unavailable: bool = False

    def to_wire(self) -> Dict[str, Any]:
        return {
            "restriction": self.restriction,
            "actions": self.actions,
            "scopeModified": self.scope_modified,
            "unavailable": self.unavailable,
        }

    @classmethod
    def from_wire(cls, payload: Mapping[str, Any]) -> "PurviewOutcome":
        return cls(
            restriction=payload.get("restriction"),
            actions=int(payload.get("actions") or 0),
            scope_modified=bool(payload.get("scopeModified")),
            unavailable=bool(payload.get("unavailable")),
        )


PurviewCheck = Callable[[str], PurviewOutcome]


def purview_outcome_from_response(body: Any) -> PurviewOutcome:
    """The outcome of a ``processContent`` response body.

    Anything unrecognised in a policy action counts as a block: a DLP rule the
    code does not understand is not a reason to send the text.
    """
    b = body if isinstance(body, Mapping) else {}
    actions = b.get("policyActions") if isinstance(b.get("policyActions"), list) else []
    restriction: Optional[str] = None
    for raw in actions:
        given = raw.get("restrictionAction") if isinstance(raw, Mapping) else None
        r = given if given in _RESTRICTION_RANK else "block"
        if restriction is None or _RESTRICTION_RANK[r] > _RESTRICTION_RANK[restriction]:
            restriction = r
    return PurviewOutcome(restriction, len(actions), b.get("protectionScopeState") == "modified", False)


def purview_unavailable(on_unavailable: str) -> PurviewOutcome:
    """The outcome when Purview could not be reached, by the caller's choice: ``allow``, ``ask`` or ``deny``."""
    restriction = "block" if on_unavailable == "deny" else "warn" if on_unavailable == "ask" else None
    return PurviewOutcome(restriction, 0, False, True)


def apply_purview(
    verdict: str, reasons: List[str], outcome: Optional[PurviewOutcome], enforce: bool = True
) -> Tuple[str, List[str]]:
    """Deliverd's verdict with Purview's held beside it: the stricter wins, and the reason says it was Purview.

    ``enforce`` false is the report-only mode, where Deliverd holds nothing
    back of its own but a Purview block still stands.
    """
    if outcome is None:
        return verdict, reasons
    reasons = list(reasons)

    def raise_to(to: str) -> None:
        nonlocal verdict
        if _VERDICT_RANK[to] > _VERDICT_RANK[verdict]:
            verdict = to

    if outcome.unavailable:
        if outcome.restriction == "block":
            raise_to("deny")
            reasons.append("Microsoft Purview could not be reached, and this agent is set not to send text Purview has not checked.")
        elif outcome.restriction == "warn" and enforce:
            raise_to("ask")
            reasons.append("Microsoft Purview could not be reached, so a person decides whether to send it unchecked.")
        else:
            reasons.append("Microsoft Purview could not be reached, so this was not checked against your Purview policies.")
        return verdict, reasons
    if outcome.restriction == "block":
        raise_to("deny")
        reasons.append("Your organisation's Microsoft Purview policy blocks sending this text.")
    elif outcome.restriction == "warn":
        if enforce:
            raise_to("ask")
            reasons.append("Your organisation's Microsoft Purview policy warns about this text, so a person decides.")
        else:
            reasons.append("Your organisation's Microsoft Purview policy warns about this text.")
    return verdict, reasons


def process_content_body(
    text: str,
    app: Mapping[str, str],
    agent: Optional[Mapping[str, str]] = None,
    correlation_id: Optional[str] = None,
    sequence_number: int = 0,
) -> Dict[str, Any]:
    """The body ``processContent`` takes for a prompt about to be sent to a model."""
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    version = app.get("version") or "1.0"
    entry: Dict[str, Any] = {
        "@odata.type": "microsoft.graph.processConversationMetadata",
        "identifier": str(uuid.uuid4()),
        "content": {"@odata.type": "microsoft.graph.textContent", "data": text},
        "name": "{} prompt".format(app["name"]),
        "correlationId": correlation_id or str(uuid.uuid4()),
        "sequenceNumber": sequence_number,
        "isTruncated": False,
        "createdDateTime": now,
        "modifiedDateTime": now,
    }
    if agent:
        info: Dict[str, Any] = {"@odata.type": "microsoft.graph.aiAgentInfo", "identifier": agent["id"], "name": agent["name"]}
        if agent.get("version"):
            info["version"] = agent["version"]
        if agent.get("blueprint_id"):
            info["blueprintId"] = agent["blueprint_id"]
        entry["agents"] = [info]
    return {
        "contentToProcess": {
            "contentEntries": [entry],
            "activityMetadata": {"activity": "uploadText"},
            "deviceMetadata": {},
            "protectedAppMetadata": {
                "name": app["name"],
                "version": version,
                "applicationLocation": {
                    "@odata.type": "microsoft.graph.policyLocationApplication",
                    "value": app["entra_app_id"],
                },
            },
            "integratedAppMetadata": {"name": app["name"], "version": version},
        }
    }


Transport = Callable[[str, Dict[str, str], bytes, float], Tuple[int, Dict[str, str], bytes]]


def _urllib_transport(url: str, headers: Dict[str, str], body: bytes, timeout: float) -> Tuple[int, Dict[str, str], bytes]:
    request = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, dict(response.headers.items()), response.read()
    except urllib.error.HTTPError as error:
        return error.code, dict(error.headers.items()) if error.headers else {}, b""


def entra_app_token(
    tenant_id: str,
    client_id: str,
    client_secret: str,
    transport: Optional[Transport] = None,
) -> Callable[[], str]:
    """A Microsoft Graph token for an app acting as itself (client credentials).

    For :func:`purview_check`'s ``token`` where there is no signed-in user: a
    pipeline, a back-end agent. Cached until five minutes before it expires.
    """
    if not _GUID.match(tenant_id):
        raise ValueError("entra_app_token: tenant_id is your Entra tenant id, a GUID.")
    send = transport or _urllib_transport
    cached: Dict[str, Any] = {"token": None, "until": 0.0}

    def token() -> str:
        if cached["token"] and time.time() < cached["until"]:
            return cached["token"]
        body = urllib.parse.urlencode(
            {
                "grant_type": "client_credentials",
                "client_id": client_id,
                "client_secret": client_secret,
                "scope": "https://graph.microsoft.com/.default",
            }
        ).encode("utf-8")
        status, _, raw = send(
            "https://login.microsoftonline.com/{}/oauth2/v2.0/token".format(tenant_id),
            {"Content-Type": "application/x-www-form-urlencoded"},
            body,
            10.0,
        )
        if status < 200 or status >= 300:
            raise RuntimeError("Entra refused the token request ({}).".format(status))
        payload = json.loads(raw.decode("utf-8"))
        if not payload.get("access_token"):
            raise RuntimeError("Entra returned no access token.")
        cached["token"] = payload["access_token"]
        cached["until"] = time.time() + max(0, int(payload.get("expires_in") or 3600) - 300)
        return cached["token"]

    return token


def purview_check(
    token: Union[str, Callable[[], str]],
    app: Mapping[str, str],
    user_id: Optional[str] = None,
    agent: Optional[Mapping[str, str]] = None,
    correlation_id: Optional[str] = None,
    on_unavailable: str = "ask",
    timeout: float = 10.0,
    transport: Optional[Transport] = None,
) -> PurviewCheck:
    """A check :meth:`deliverd.Deliverd.screen` runs on the text before asking Deliverd.

    ``token`` is a Microsoft Graph access token, or a callable returning one,
    called on every check so a credential can refresh it. ``app`` is your app
    as Purview knows it: ``name`` and ``entra_app_id`` (its application id),
    with an optional ``version``. ``user_id`` is the Entra object id of the
    user the text is for; omit it to use ``/me`` with a delegated token.
    ``agent`` (``id``, ``name``, optional ``version`` and ``blueprint_id``)
    names the agent sending it. ``on_unavailable`` is ``allow``, ``ask`` (the
    default: a person decides) or ``deny``.
    """
    if not _GUID.match(app.get("entra_app_id", "")):
        raise ValueError("purview_check: app['entra_app_id'] is your Entra app's application (client) id, a GUID.")
    if user_id is not None and not _GUID.match(user_id):
        raise ValueError("purview_check: user_id is the user's Entra object id, a GUID.")
    if on_unavailable not in ("allow", "ask", "deny"):
        raise ValueError("purview_check: on_unavailable is 'allow', 'ask' or 'deny'.")
    url = "{}/{}/dataSecurityAndGovernance/processContent".format(_GRAPH, "users/" + user_id if user_id else "me")
    send = transport or _urllib_transport
    state: Dict[str, Any] = {"etag": None, "sequence": 0}

    def check(text: str) -> PurviewOutcome:
        try:
            bearer = token() if callable(token) else token
            headers = {"Authorization": "Bearer " + bearer, "Content-Type": "application/json"}
            if state["etag"]:
                headers["If-None-Match"] = state["etag"]
            body = json.dumps(process_content_body(text, app, agent, correlation_id, state["sequence"])).encode("utf-8")
            state["sequence"] += 1
            status, response_headers, raw = send(url, headers, body, timeout)
            if status in (202, 204):
                return PurviewOutcome(None)
            if status < 200 or status >= 300:
                return purview_unavailable(on_unavailable)
            etag = next((v for k, v in response_headers.items() if k.lower() == "etag"), None)
            outcome = purview_outcome_from_response(json.loads(raw.decode("utf-8")))
            # Purview's policies changed, or first sight: the next call starts from this state.
            state["etag"] = etag or state["etag"]
            return outcome
        except Exception:
            return purview_unavailable(on_unavailable)

    return check
