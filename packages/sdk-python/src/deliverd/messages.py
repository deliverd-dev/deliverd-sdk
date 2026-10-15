"""What a failure says.

An error is part of the interface, and ``ERR_POLICY_SUBJECT_RESOLUTION_FAILED``
is an interface that tells a developer to go and read something. These say what
happened, why, and the one thing to do next — because the person reading it is
stuck, at a keyboard, and does not want a search engine.

Keyed on the codes the API actually returns. Anything unlisted keeps the API's
own message, which is written for a person too.

Kept in step with ``packages/sdk/src/messages.ts``: the two tables are held to
each other by ``apps/web/src/lib/api/sdk-parity.test.ts``, because a hint that
names ``expiresIn`` to a Python caller who typed ``expires_in`` sends them to
look for a field that does not exist in their language.
"""

from __future__ import annotations

from typing import Dict, NamedTuple, Optional


class Explanation(NamedTuple):
    """What to say instead of the API's message, and what to do about it."""

    hint: str
    #: Replaces the API's message when we can say it better.
    message: Optional[str] = None


#: Where somebody without an account makes one, counted against this package.
SIGN_UP_URL = (
    "https://deliverd.dev/sign-up?utm_source=pypi&utm_medium=package"
    "&utm_campaign=python-sdk&utm_content=no-api-key"
)

EXPLANATIONS: Dict[str, Explanation] = {
    # The one moment somebody has installed the package and has no account:
    # the link is the way to get one, tagged so a sign-up from here is counted
    # against this package.
    "no_api_key": Explanation(
        message="No API key.",
        hint=(
            "Set DELIVERD_API_KEY in your environment, or pass api_key= — or use "
            'Deliverd(mode="development") to run without one. No account yet? '
            "Setting up a free one hands you a key: " + SIGN_UP_URL
        ),
    ),
    "auth_error": Explanation(
        message="That credential was not accepted.",
        # Both families, because both work: a `dlv_` key somebody created, or a
        # `dlvo_` access token from an OAuth connector. Naming only the first is
        # how a connector's token gets thrown away and replaced with a key
        # nobody needed to create.
        #
        # Credentials only. A missing scope is ``insufficient_scope`` below and
        # has been since ``ApiScopeError`` existed — the two shared this code
        # before that, which is how somebody whose key was perfectly good came
        # to be told to go and check their key.
        hint=(
            "Check DELIVERD_API_KEY. An API key starts with dlv_ and is created in "
            "Settings → API tokens; an OAuth access token starts with dlvo_ and "
            "needs no setup."
        ),
    ),
    "insufficient_scope": Explanation(
        message="That credential is valid and does not carry the scope this call needs.",
        hint=(
            "Reissue the key with the scope named above, or re-consent the connector "
            "for it. A credential issued before a scope existed does not have it — "
            "nothing is wrong with the key itself, so replacing it with another of "
            "the same scopes will fail the same way."
        ),
    ),
    "unknown_approver": Explanation(
        message="No approver could be found for this request.",
        hint=(
            "Everyone in `approvers` must be an active member of your organisation, "
            "named by email or user id. Invite them first, or leave `approvers` out "
            "and your owners and admins decide."
        ),
    ),
    "self_approval": Explanation(
        message="You cannot approve your own request.",
        hint=(
            "Name somebody else in `approvers`, or leave it out so your "
            "organisation's owners and admins decide."
        ),
    ),
    "not_approver": Explanation(
        hint="Only the people named on the request can decide it.",
    ),
    "not_requester": Explanation(
        message="Only the requester can answer a question on their own request.",
        hint="Use the same key that created the approval.",
    ),
    "not_pending": Explanation(
        message="That request was already decided.",
        hint="Read its status rather than deciding again; a decision is final.",
    ),
    "expired": Explanation(
        message="That request expired before anyone decided it.",
        hint="Ask again, with a longer `expires_in`, or chase the approver.",
    ),
    "rate_limited": Explanation(
        message="Too many requests.",
        hint=(
            "The SDK already retried and gave up. Reduce how often you poll, or wait "
            "with approve() rather than looping yourself."
        ),
    ),
    "plan_limit": Explanation(
        hint="Your organisation's plan does not include this. Billing → Plans.",
    ),
    "network_error": Explanation(
        hint=(
            "Check the machine's network and `base_url`. Deliverd's status is at "
            "https://deliverd.dev."
        ),
    ),
    "timeout": Explanation(
        hint=(
            "You stopped waiting; the request is still open at the URL above until it "
            "expires. If an approver asked a question, answer it with an on_question "
            "handler — an unanswered question is the commonest reason a wait runs out."
        ),
    ),
    # The gate and its policy, which had no entries at all until the codes were
    # told apart — the newest surface in the API and the one a reader is least
    # likely to recognise, falling through to the server's own message with no
    # next step.
    #
    # The first two are met through ``deliverd.gate()``. The last three come
    # from authoring, which no namespace covers, so a caller reaches them
    # through ``deliverd.http`` — still the API's codes, still worth
    # explaining, and the reason this table is keyed on what the API returns
    # rather than on which namespace produced it.
    # The one code every namespace can return, and the only entry here that is
    # about what a status *means* rather than about a particular call.
    #
    # It had none until a policy id that does not exist stopped answering 500,
    # and the reason to write one is the half a reader does not expect: a 404
    # is also what this API says when the thing is there and not theirs. It is
    # one answer on purpose -- telling the two apart would say whether the id
    # exists for somebody else -- so "it was deleted" is a guess, and a retry
    # cannot turn it into anything else.
    #
    # No message: the server's own sentence names the resource, and this table
    # cannot, being shared by approvals, reports and policies alike.
    "not_found": Explanation(
        hint=(
            "Nothing with that id, or nothing this key may see -- the API does not "
            "say which, because saying would tell you whether it exists for somebody "
            "else. Check the id, and that the key belongs to the organisation that "
            "owns it. Retrying will not change the answer."
        ),
    ),
    # The 404s that name their own resource. Each is here for a fact the
    # server's sentence cannot carry, which is the only reason to add one --
    # repeating "not found" under a longer name would be noise.
    #
    # report_not_found is deliberately absent. Placing and releasing a legal
    # hold is web-only by design, so no route can send it and an entry would
    # be advice nobody receives; sdk-parity.test.ts holds that omission to the
    # reason the app already records, and fails if it ever becomes reachable.
    "agent_not_found": Explanation(
        message="The agent identity this key acts as is not there any more.",
        hint=(
            "Nothing is wrong with the credential -- it still authenticates, and "
            "what is gone is the identity it speaks as. Recreate the agent under "
            "Admin > Agents, or issue a key bound to one that exists. Every call "
            "this key makes fails the same way until then."
        ),
    ),
    "upload_not_found": Explanation(
        hint=(
            "A publish consumes the bundle it reads, so this is what a *second* "
            "publish with the same upload_id gets -- which means the first one may "
            "well have worked. Look at the report before uploading again, or you "
            "will publish it twice."
        ),
    ),
    "question_not_found": Explanation(
        hint=(
            "Question ids belong to one approval, so this is usually an id from a "
            "different one. Take it from that approval's own questions -- an "
            "on_question handler is handed it -- rather than from anywhere you "
            "cached it. A question already answered is `already_answered`, not this."
        ),
    ),
    "quote_not_found": Explanation(
        hint=(
            "The passage is not in the version the message names. A republish "
            "rewrites the text, so a quote taken before one stops matching: read the "
            "current version and quote what it says now. A quote that matches in "
            "several places is `quote_ambiguous` instead, and an empty one is "
            "`quote_empty`."
        ),
    ),
    "unknown_action": Explanation(
        message="No action by that name is registered.",
        hint=(
            "Register it first — `deliverd actions push`, or POST /v1/actions — and "
            "use the same dotted id. A gate on an unregistered action is refused "
            "before any rule is read, so this is not a policy saying no."
        ),
    ),
    "invalid_input": Explanation(
        message="The arguments do not match the action's registered schema.",
        hint=(
            "Read `details` for the field. The schema is the one your organisation "
            "registered for this action, so either the call is wrong or the "
            "registration is out of date."
        ),
    ),
    "invalid_rules": Explanation(
        message="Those rules cannot be stored as written.",
        hint=(
            "Read `details` — it names each condition that could not be checked, "
            "usually a field no registered action declares. This is refused now "
            "rather than at evaluation, where the rule would match nothing and look "
            "like one that had simply not fired."
        ),
    ),
    "duplicate": Explanation(
        hint=(
            "Something with that name is already there. Add a version to it rather "
            "than creating a second one."
        ),
    ),
    "superseded": Explanation(
        hint=(
            "It was replaced while you were working. Read the current one and act on "
            "that; copy its contents into a new version rather than reviving the old, "
            "because a past decision points at what it said."
        ),
    ),
    "approval_invalidated": Explanation(
        message="The artifact is not the one that was approved.",
        hint=(
            "Its hash changed after the decision, so the permission does not cover it. Ask again for this version; the new request can name the old one as `supersedesGateId`."
        ),
    ),
    "destination_mismatch": Explanation(
        message="That destination is not the one that was approved.",
        hint=(
            "A permission covers the destination it was asked for. Ask again for the new one rather than sending somewhere else under it."
        ),
    ),
    "artifact_missing": Explanation(
        message="This permission is for a specific artifact, and none was named.",
        hint=(
            "Send the SHA-256 of what you are about to use, so it can be checked against what was approved."
        ),
    ),
    "gate_used": Explanation(
        message="That permission has been used.",
        hint=(
            "A permission covers one use unless policy said otherwise. Ask again for the next action."
        ),
    ),
    "gate_expired": Explanation(
        message="The window on that permission has closed.",
        hint=(
            "Ask again. The window is set by policy, and an approval does not stretch to cover the same act later."
        ),
    ),
    "gate_revoked": Explanation(
        message="That permission was withdrawn after it was given.",
        hint=(
            "Do not act. Read the gate for who revoked it and why, and ask again if the work still needs doing."
        ),
    ),
    "gate_cancelled": Explanation(
        message="That request was withdrawn.",
        hint=(
            "Ask again if the work still needs doing."
        ),
    ),
    "not_authorised": Explanation(
        message="Nothing authorises this yet.",
        hint=(
            "Read `blockedBecause` on the gate: it is waiting on a person, was refused, or was sent back for changes. Act only when `canExecute` is true."
        ),
    ),
    "idempotency_conflict": Explanation(
        message="That external id was already used for a different act.",
        hint=(
            "An external id names one decision. Use a new id for a different action, destination or artifact."
        ),
    ),
    "claim_not_found": Explanation(
        message="No started execution with that claim id.",
        hint=(
            "Send the `claimId` the `started` receipt returned, or report `completed` without one."
        ),
    ),
    "claim_finished": Explanation(
        message="That execution has already been reported finished.",
        hint=(
            "Each claim finishes once. Read the gate for its receipts rather than reporting again."
        ),
    ),
    "artifact_mismatch": Explanation(
        message="That artifact does not belong to the report named.",
        hint=(
            "Name a version of the same report, or leave `versionId` out to bind the current one."
        ),
    ),
    "invalid_signature": Explanation(
        hint=(
            "Check the endpoint's signing secret, and that you passed the raw request "
            "body rather than a re-encoded object."
        ),
    ),
    # The Task Graph's refusals: the server says what happened, these say
    # which call comes next.
    "version_conflict": Explanation(
        hint=(
            "Somebody wrote to the task between your read and your write. Read it again (`task.refresh()`), reapply your change to what is there now, and pass the new `expected_version`."
        ),
    ),
    "not_completed": Explanation(
        hint=(
            "Only a completed side task has a result to apply. Finish it with `complete()` first; a cancelled one has to be reopened and completed."
        ),
    ),
    "already_applied": Explanation(
        hint=(
            "Applying happens once, so the parent is never given the same decisions twice. To change what was carried up, `reopen()` the side task, complete it again and apply the new result."
        ),
    ),
}


def explain(code: str, api_message: str) -> "tuple[str, Optional[str]]":
    """The message as a developer should read it: what happened, then what to do."""
    found = EXPLANATIONS.get(code)
    if found is None:
        return api_message, None
    return "{}\n{}".format(found.message or api_message, found.hint), found.hint
