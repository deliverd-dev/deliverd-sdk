using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Deliverd;

/// <summary>Where an approval stands. Strings, as the API sends them, so a new one never fails to parse.</summary>
public static class ApprovalStatus
{
    /// <summary>Nobody has decided yet.</summary>
    public const string Pending = "pending";
    /// <summary>A person agreed.</summary>
    public const string Approved = "approved";
    /// <summary>A person refused.</summary>
    public const string Rejected = "rejected";
    /// <summary>A person sent it back rather than approve it.</summary>
    public const string ChangesRequested = "changes_requested";
    /// <summary>Nobody answered in time.</summary>
    public const string Expired = "expired";
    /// <summary>Withdrawn before anyone decided.</summary>
    public const string Cancelled = "cancelled";
}

/// <summary>
/// What a gate decision can be. <c>allowed</c> and <c>denied</c> are what a rule
/// said; the rest are what a person did about a request no rule settled.
/// </summary>
public static class GateStatus
{
    /// <summary>A rule permitted it.</summary>
    public const string Allowed = "allowed";
    /// <summary>A rule refused it.</summary>
    public const string Denied = "denied";
    /// <summary>Waiting on a person.</summary>
    public const string Pending = "pending";
    /// <summary>A person agreed to it.</summary>
    public const string Approved = "approved";
    /// <summary>A person refused it.</summary>
    public const string Rejected = "rejected";
    /// <summary>A person sent it back.</summary>
    public const string ChangesRequested = "changes_requested";
    /// <summary>Nobody answered in time.</summary>
    public const string Expired = "expired";
    /// <summary>Withdrawn before anyone decided.</summary>
    public const string Cancelled = "cancelled";
    /// <summary>A person took the permission back before it was used.</summary>
    public const string Revoked = "revoked";
    /// <summary>The permission has been used.</summary>
    public const string Used = "used";
}

/// <summary>One line of evidence shown to the approver.</summary>
public sealed class Factor
{
    /// <summary>What the line says.</summary>
    public string Label { get; set; } = string.Empty;
    /// <summary><c>ok</c>, <c>warning</c> or <c>info</c>.</summary>
    public string? Status { get; set; }
    /// <summary>More, shown underneath.</summary>
    public string? Detail { get; set; }

    internal JsonObject ToJson()
    {
        var o = new JsonObject { ["label"] = Label };
        if (Status is not null) o["status"] = Status;
        if (Detail is not null) o["detail"] = Detail;
        return o;
    }
}

/// <summary>Which agent is asking, in your words. Recorded and shown as declared; nothing is decided on it.</summary>
public sealed class DeclaredAgent
{
    /// <summary>The agent's name.</summary>
    public string? Name { get; set; }
    /// <summary>Who runs it: <c>microsoft</c>, <c>openai</c>…</summary>
    public string? Provider { get; set; }
    /// <summary>Your own id for it.</summary>
    public string? ExternalId { get; set; }

    internal JsonObject ToJson()
    {
        var o = new JsonObject();
        if (Name is not null) o["name"] = Name;
        if (Provider is not null) o["provider"] = Provider;
        if (ExternalId is not null) o["externalId"] = ExternalId;
        return o;
    }
}

/// <summary>One field a person corrected.</summary>
public sealed class FieldChange
{
    /// <summary>The field's name.</summary>
    public string Field { get; init; } = string.Empty;
    /// <summary>What it was.</summary>
    public JsonNode? From { get; init; }
    /// <summary>What it is now.</summary>
    public JsonNode? To { get; init; }

    internal static IReadOnlyList<FieldChange> ListFrom(JsonNode? node) =>
        node is JsonArray array
            ? array.OfType<JsonObject>()
                .Select(c => new FieldChange { Field = Json.String(c, "field") ?? string.Empty, From = c["from"]?.DeepClone(), To = c["to"]?.DeepClone() })
                .ToList()
            : Array.Empty<FieldChange>();
}

/// <summary>Ask a person: what they are shown, who may decide, and how long they have.</summary>
public sealed class ApprovalRequest
{
    /// <summary>What is being asked, as a headline.</summary>
    public string Title { get; set; } = string.Empty;
    /// <summary>The detail under the headline. Markdown.</summary>
    public string? Description { get; set; }
    /// <summary><c>low</c>, <c>medium</c>, <c>high</c> or <c>critical</c>.</summary>
    public string? Risk { get; set; }
    /// <summary>Evidence lines shown to the approver.</summary>
    public IList<Factor> Factors { get; set; } = new List<Factor>();
    /// <summary>People, teams or groups who may decide. Your owners and admins when empty.</summary>
    public IList<string> Approvers { get; set; } = new List<string>();
    /// <summary>An exact moment it expires. Takes precedence over <see cref="ExpiresIn"/>.</summary>
    public DateTimeOffset? ExpiresAt { get; set; }
    /// <summary>How long until it expires, worked out when the call is made.</summary>
    public TimeSpan? ExpiresIn { get; set; }
    /// <summary>Your own reference. With one, a restarted agent reuses its request instead of asking twice.</summary>
    public string? ExternalId { get; set; }
    /// <summary>The flow (a project, in the app) it belongs to.</summary>
    public string? FlowId { get; set; }
    /// <summary>Where to POST the outcome instead of polling.</summary>
    public string? CallbackUrl { get; set; }
    /// <summary>Anything you want back on the record.</summary>
    public JsonObject? Metadata { get; set; }
    /// <summary>What you will run with if it is approved, shown to the approver field by field.</summary>
    public JsonObject? Input { get; set; }
    /// <summary>Fields of <see cref="Input"/> the approver may correct.</summary>
    public IList<string> EditableFields { get; set; } = new List<string>();
    /// <summary>Which agent is asking, as you describe it.</summary>
    public DeclaredAgent? Agent { get; set; }
    /// <summary>The model the agent is running on.</summary>
    public string? Model { get; set; }

    internal JsonObject ToJson(TimeSpan? fallbackExpiry)
    {
        var o = new JsonObject { ["title"] = Title };
        if (Description is not null) o["description"] = Description;
        if (Risk is not null) o["risk"] = Risk;
        if (Factors.Count > 0) o["factors"] = new JsonArray(Factors.Select(f => (JsonNode)f.ToJson()).ToArray());
        if (Approvers.Count > 0) o["approvers"] = new JsonArray(Approvers.Select(a => (JsonNode)JsonValue.Create(a)!).ToArray());
        var expiresIn = ExpiresIn ?? fallbackExpiry;
        var expiresAt = ExpiresAt ?? (expiresIn is { } span ? DateTimeOffset.UtcNow + span : null);
        if (expiresAt is { } at) o["expiresAt"] = DeliverdDuration.Iso(at);
        if (ExternalId is not null) o["externalId"] = ExternalId;
        if (FlowId is not null) o["flowId"] = FlowId;
        if (CallbackUrl is not null) o["callbackUrl"] = CallbackUrl;
        if (Metadata is not null) o["metadata"] = Metadata.DeepClone();
        if (Input is not null) o["input"] = Input.DeepClone();
        if (EditableFields.Count > 0) o["editableFields"] = new JsonArray(EditableFields.Select(f => (JsonNode)JsonValue.Create(f)!).ToArray());
        if (Agent is not null) o["agent"] = Agent.ToJson();
        if (Model is not null) o["model"] = Model;
        return o;
    }
}

/// <summary>An approval request, as the API returns it.</summary>
public sealed class ApprovalData
{
    /// <summary>The request's id.</summary>
    public string Id { get; init; } = string.Empty;
    /// <summary>One of <see cref="ApprovalStatus"/>.</summary>
    public string Status { get; init; } = ApprovalStatus.Pending;
    /// <summary>The page the approver decides on.</summary>
    public string Url { get; init; } = string.Empty;
    /// <summary>The headline.</summary>
    public string Title { get; init; } = string.Empty;
    /// <summary>Your own reference, when you gave one.</summary>
    public string? ExternalId { get; init; }
    /// <summary>What you proposed to run with, unchanged.</summary>
    public JsonObject? Input { get; init; }
    /// <summary>What to run with once approved: <see cref="Input"/> with any corrections.</summary>
    public JsonObject? ApprovedInput { get; init; }
    /// <summary>The corrections, field by field.</summary>
    public IReadOnlyList<FieldChange> Changes { get; init; } = Array.Empty<FieldChange>();
    /// <summary>Who decided, as a name rather than an id.</summary>
    public string? DecidedBy { get; init; }
    /// <summary>When they decided.</summary>
    public string? DecidedAt { get; init; }
    /// <summary>The approver's reason, when they gave one.</summary>
    public string? Note { get; init; }
    /// <summary>Questions the approver asked that nobody has answered yet.</summary>
    public IReadOnlyList<string> OpenQuestions { get; init; } = Array.Empty<string>();
    /// <summary>Everything the API returned, for a field this type does not name.</summary>
    public JsonObject Raw { get; init; } = new();

    /// <summary>Still waiting on a person.</summary>
    public bool IsPending => Status == ApprovalStatus.Pending;

    /// <summary>Reads an approval from the API's JSON.</summary>
    public static ApprovalData From(JsonNode? node)
    {
        var o = node as JsonObject ?? throw Json.Unexpected("An approval");
        return new ApprovalData
        {
            Id = Json.String(o, "id") ?? throw Json.Unexpected("An approval with no id"),
            Status = Json.String(o, "status") ?? ApprovalStatus.Pending,
            Url = Json.String(o, "url") ?? string.Empty,
            Title = Json.String(o, "title") ?? string.Empty,
            ExternalId = Json.String(o, "externalId"),
            Input = o["input"]?.DeepClone() as JsonObject,
            ApprovedInput = o["approvedInput"]?.DeepClone() as JsonObject,
            Changes = FieldChange.ListFrom(o["changes"]),
            DecidedBy = Json.String(o, "decidedBy"),
            DecidedAt = Json.String(o, "decidedAt"),
            Note = Json.String(o, "note"),
            OpenQuestions = o["questions"] is JsonArray questions
                ? questions.OfType<JsonObject>().Where(q => q["answer"] is null).Select(q => Json.String(q, "question") ?? string.Empty).ToList()
                : Array.Empty<string>(),
            Raw = (JsonObject)o.DeepClone(),
        };
    }

    /// <summary>The answer, flattened: what <see cref="DeliverdClient.ApproveAsync"/> hands back.</summary>
    public Decision ToDecision()
    {
        var approved = Status == ApprovalStatus.Approved;
        return new Decision
        {
            Approved = approved,
            Status = IsPending ? ApprovalStatus.Expired : Status,
            Note = Note,
            DecidedBy = DecidedBy,
            DecidedAt = DecidedAt,
            Id = Id,
            Url = Url,
            Input = approved ? ApprovedInput ?? Input : null,
            Changes = Changes,
            Approval = this,
        };
    }
}

/// <summary>A person's answer, flattened.</summary>
public sealed class Decision
{
    /// <summary>True only for an approval. False for rejected, changes requested, expired and cancelled.</summary>
    public bool Approved { get; init; }
    /// <summary>One of <see cref="ApprovalStatus"/>, never <c>pending</c>.</summary>
    public string Status { get; init; } = ApprovalStatus.Expired;
    /// <summary>The approver's reason, when they gave one.</summary>
    public string? Note { get; init; }
    /// <summary>Who decided.</summary>
    public string? DecidedBy { get; init; }
    /// <summary>When.</summary>
    public string? DecidedAt { get; init; }
    /// <summary>The request's id.</summary>
    public string Id { get; init; } = string.Empty;
    /// <summary>The request's page.</summary>
    public string Url { get; init; } = string.Empty;
    /// <summary>
    /// What to run with, when you sent an input and it was approved: yours, with
    /// the approver's corrections. Null otherwise; never run the proposal then.
    /// </summary>
    public JsonObject? Input { get; init; }
    /// <summary>The corrections, field by field.</summary>
    public IReadOnlyList<FieldChange> Changes { get; init; } = Array.Empty<FieldChange>();
    /// <summary>The request as it settled.</summary>
    public ApprovalData Approval { get; init; } = new();
}

/// <summary>Ask whether to act, and let the organisation's policy answer.</summary>
public sealed class GateRequest
{
    /// <summary>The registered action: <c>finance.refund</c>.</summary>
    public string Action { get; set; } = string.Empty;
    /// <summary>
    /// Required: your own id for this unit of work (<c>refund:ord_8812</c>), so a
    /// retry re-reads the decision instead of asking twice. Sent as the HTTP
    /// idempotency key as well.
    /// </summary>
    public string ExternalId { get; set; } = string.Empty;
    /// <summary>The arguments you will actually execute with.</summary>
    public JsonObject Input { get; set; } = new();
    /// <summary><c>production</c>, <c>staging</c>…</summary>
    public string? Environment { get; set; }
    /// <summary>Why the agent wants to act.</summary>
    public string? Reason { get; set; }
    /// <summary>The flow it belongs to.</summary>
    public string? FlowId { get; set; }
    /// <summary>A plain account of the act.</summary>
    public string? Description { get; set; }
    /// <summary>Where to POST the outcome instead of polling.</summary>
    public string? CallbackUrl { get; set; }
    /// <summary>Anything you want back on the record.</summary>
    public JsonObject? Metadata { get; set; }

    internal JsonObject ToJson()
    {
        var o = new JsonObject
        {
            ["actionId"] = Action,
            ["input"] = Input.DeepClone(),
            ["externalId"] = ExternalId,
        };
        if (Environment is not null) o["environment"] = Environment;
        if (Reason is not null) o["reason"] = Reason;
        if (FlowId is not null) o["flowId"] = FlowId;
        if (Description is not null) o["description"] = Description;
        if (CallbackUrl is not null) o["callbackUrl"] = CallbackUrl;
        if (Metadata is not null) o["metadata"] = Metadata.DeepClone();
        return o;
    }
}

/// <summary>A gate, as the API returns it.</summary>
public sealed class GateData
{
    /// <summary>The gate's id.</summary>
    public string Id { get; init; } = string.Empty;
    /// <summary>One of <see cref="GateStatus"/>.</summary>
    public string Status { get; init; } = GateStatus.Pending;
    /// <summary>The one to branch on: a rule permitted it or a person agreed to it.</summary>
    public bool Allowed { get; init; }
    /// <summary>What to execute with: the validated input, or the approver's correction.</summary>
    public JsonObject Input { get; init; } = new();
    /// <summary>The corrections, field by field.</summary>
    public IReadOnlyList<FieldChange> Changes { get; init; } = Array.Empty<FieldChange>();
    /// <summary>Why, in the rule's or the person's words.</summary>
    public string? Reason { get; init; }
    /// <summary>The rule that decided, when one did.</summary>
    public string? Rule { get; init; }
    /// <summary>The page a person decides on, when it went to one.</summary>
    public string? ApprovalUrl { get; init; }
    /// <summary>True when this call read back a decision already made under your id.</summary>
    public bool Reused { get; init; }
    /// <summary>Whether you may act on it now: authorised, in its window, with a use left.</summary>
    public bool CanExecute { get; init; }
    /// <summary>The registered action.</summary>
    public string ActionId { get; init; } = string.Empty;
    /// <summary>Everything the API returned.</summary>
    public JsonObject Raw { get; init; } = new();

    /// <summary>Still waiting on a person.</summary>
    public bool IsPending => Status == GateStatus.Pending;
    /// <summary>Refused by a rule, as against rejected by a person.</summary>
    public bool IsDenied => Status == GateStatus.Denied;

    /// <summary>Reads a gate from the API's JSON.</summary>
    public static GateData From(JsonNode? node)
    {
        var o = node as JsonObject ?? throw Json.Unexpected("A gate");
        return new GateData
        {
            Id = Json.String(o, "id") ?? throw Json.Unexpected("A gate with no id"),
            Status = Json.String(o, "status") ?? GateStatus.Pending,
            Allowed = Json.Bool(o, "allowed"),
            Input = o["input"]?.DeepClone() as JsonObject ?? new JsonObject(),
            Changes = FieldChange.ListFrom(o["changes"]),
            Reason = Json.String(o, "reason"),
            Rule = Json.String(o, "rule"),
            ApprovalUrl = Json.String(o, "approvalUrl"),
            Reused = Json.Bool(o, "reused"),
            CanExecute = Json.Bool(o, "canExecute"),
            ActionId = Json.String(o, "actionId") ?? string.Empty,
            Raw = (JsonObject)o.DeepClone(),
        };
    }

    /// <summary>The answer, flattened: what <see cref="DeliverdClient.GateAsync"/> hands back.</summary>
    public GateDecision ToDecision() => new()
    {
        Allowed = Allowed,
        Status = Status,
        Reason = Reason,
        Rule = Rule,
        Input = Input,
        Changes = Changes,
        Id = Id,
        ApprovalUrl = ApprovalUrl,
        Gate = this,
    };
}

/// <summary>A gate's answer, flattened.</summary>
public sealed class GateDecision
{
    /// <summary>A rule permitted it, or a person agreed to it. False while pending.</summary>
    public bool Allowed { get; init; }
    /// <summary>One of <see cref="GateStatus"/>.</summary>
    public string Status { get; init; } = GateStatus.Pending;
    /// <summary>Why.</summary>
    public string? Reason { get; init; }
    /// <summary>The rule that decided, when one did.</summary>
    public string? Rule { get; init; }
    /// <summary>What to execute with.</summary>
    public JsonObject Input { get; init; } = new();
    /// <summary>The corrections, field by field.</summary>
    public IReadOnlyList<FieldChange> Changes { get; init; } = Array.Empty<FieldChange>();
    /// <summary>The gate's id.</summary>
    public string Id { get; init; } = string.Empty;
    /// <summary>The page a person decides on, when it went to one.</summary>
    public string? ApprovalUrl { get; init; }
    /// <summary>The gate as it stands.</summary>
    public GateData Gate { get; init; } = new();
}

internal static class Json
{
    public static string? String(JsonObject o, string name) =>
        o[name] is JsonValue v && v.GetValueKind() == JsonValueKind.String ? v.GetValue<string>() : null;

    public static bool Bool(JsonObject o, string name) =>
        o[name] is JsonValue v && v.GetValueKind() == JsonValueKind.True;

    public static DeliverdException Unexpected(string what) =>
        new(0, "invalid_response", $"{what} was not the shape expected.");
}
