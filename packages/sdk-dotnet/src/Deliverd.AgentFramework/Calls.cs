using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.AI;

namespace Deliverd.AgentFramework;

/// <summary>One tool call waiting on an answer, as the adapter reads it.</summary>
public sealed class DeliverdToolCall
{
    /// <summary>The prefix every request this adapter files carries in its external id.</summary>
    /// <remarks>
    /// The same as the Python adapter's, so an agent that moves between the two
    /// finds the requests it already made.
    /// </remarks>
    public const string ExternalIdPrefix = "agent-framework:";

    /// <summary>The framework's id for the call.</summary>
    public string CallId { get; init; } = string.Empty;
    /// <summary>The tool's name.</summary>
    public string Tool { get; init; } = string.Empty;
    /// <summary>The arguments the model chose, as JSON.</summary>
    public JsonNode? Arguments { get; init; }
    /// <summary>The MCP server it would run on, when it is a hosted MCP tool.</summary>
    public string? Server { get; init; }
    /// <summary><c>agent-framework:&lt;call id&gt;</c>: what a retried round finds its request by.</summary>
    public string ExternalId { get; init; } = string.Empty;

    /// <summary>Reads any tool call the framework can ask about.</summary>
    public static DeliverdToolCall From(AIContent toolCall, string? requestId = null)
    {
        string? tool;
        IDictionary<string, object?>? arguments;
        string? server = null;
        switch (toolCall)
        {
            case FunctionCallContent function:
                tool = function.Name;
                arguments = function.Arguments;
                break;
            // A hosted MCP call, Foundry's or OpenAI's, names its server.
            case McpServerToolCallContent mcp:
                tool = mcp.Name;
                arguments = mcp.Arguments;
                server = mcp.ServerName;
                break;
            default:
                tool = null;
                arguments = null;
                break;
        }
        tool = string.IsNullOrEmpty(tool) ? "a tool" : tool;
        var args = arguments is null ? new JsonObject() : JsonSerializer.SerializeToNode(arguments, AIJsonUtilities.DefaultOptions);
        var callId = (toolCall as ToolCallContent)?.CallId;
        if (string.IsNullOrEmpty(callId)) callId = requestId;
        if (string.IsNullOrEmpty(callId)) callId = tool + ":" + Texts.Fingerprint(args);
        return new DeliverdToolCall
        {
            CallId = callId!,
            Tool = tool!,
            Arguments = args,
            Server = server,
            ExternalId = ExternalIdPrefix + callId,
        };
    }
}

/// <summary>What a person is shown about one tool call.</summary>
public sealed class ToolCallDescription
{
    /// <summary>The headline.</summary>
    public string Title { get; set; } = string.Empty;
    /// <summary>The detail. Markdown.</summary>
    public string? Description { get; set; }
    /// <summary><c>low</c>, <c>medium</c>, <c>high</c> or <c>critical</c>.</summary>
    public string? Risk { get; set; }
    /// <summary>Evidence lines.</summary>
    public IList<Factor> Factors { get; set; } = new List<Factor>();
}

/// <summary>
/// The sentences the model reads when a call is not run. They are the same as
/// the Python adapter's, word for word, so an agent's behaviour does not depend
/// on which SDK asked.
/// </summary>
internal static class Texts
{
    /// <summary>The input shown field by field on the approval page, when it is a plain object of a sensible size.</summary>
    public const int InputMax = 8000;
    public const int InputPreviewMax = 3000;

    private static readonly JsonSerializerOptions Indented = new()
    {
        WriteIndented = true,
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    private static readonly JsonSerializerOptions Compact = new()
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    private static string Sentence(string text)
    {
        text = text.Trim();
        return text.EndsWith(".", StringComparison.Ordinal) || text.EndsWith("!", StringComparison.Ordinal) || text.EndsWith("?", StringComparison.Ordinal)
            ? text
            : text + ".";
    }

    /// <summary>Why a call was not run, as a sentence the model can read and act on.</summary>
    public static string Refusal(string tool, string status, string? note = null, string? decidedBy = null)
    {
        var who = decidedBy is null ? string.Empty : $" by {decidedBy}";
        var hasNote = !string.IsNullOrWhiteSpace(note);
        switch (status)
        {
            case ApprovalStatus.Rejected:
                return $"A person declined running {tool}{who}.{(hasNote ? $" Their reason: {Sentence(note!)}" : string.Empty)} Do not retry it; change course or ask how to proceed.";
            case ApprovalStatus.ChangesRequested:
                return $"A person sent {tool} back{who} rather than approve it.{(hasNote ? $" Their note: {Sentence(note!)}" : string.Empty)} Do not run it as proposed; change it or ask how to proceed.";
            case GateStatus.Denied:
                return $"The organisation's policy does not allow running {tool}.{(hasNote ? $" Why: {Sentence(note!)}" : string.Empty)} Do not retry it; change course or ask how to proceed.";
            case ApprovalStatus.Expired:
                return $"Nobody decided whether to run {tool} before the request expired, so it was not run.";
            default:
                return $"The request to run {tool} was withdrawn, so it was not run.";
        }
    }

    /// <summary>A call approved only with corrections: the proposal must not run.</summary>
    public static string Changed(string tool, IEnumerable<FieldChange> changes)
    {
        var parts = changes.Select(c => $"{c.Field} from {Render(c.From)} to {Render(c.To)}");
        return $"A person approved {tool} only with changes: {string.Join("; ", parts)}. It was not run as proposed. If it is still needed, call it again with those values.";
    }

    private static string Render(JsonNode? node) => node is null ? "null" : node.ToJsonString(Compact);

    /// <summary>A plain account of a call, for when the caller did not write one.</summary>
    public static ToolCallDescription DefaultDescription(DeliverdToolCall call)
    {
        var rendered = call.Arguments is JsonValue v && v.GetValueKind() == JsonValueKind.String
            ? v.GetValue<string>()
            : call.Arguments?.ToJsonString(Indented) ?? string.Empty;
        if (rendered.Length > InputPreviewMax) rendered = rendered.Substring(0, InputPreviewMax - 1) + "…";
        var where = call.Server is null ? string.Empty : $" on {call.Server}";
        return new ToolCallDescription
        {
            Title = $"Allow the agent to run {call.Tool}{where}",
            Description = rendered.Length > 0 ? $"With this input:\n\n{rendered}" : null,
            Risk = "medium",
        };
    }

    /// <summary>The input as the approval page shows it, field by field, or null.</summary>
    public static JsonObject? Structured(JsonNode? value) =>
        value is JsonObject o && o.ToJsonString().Length <= InputMax ? (JsonObject)o.DeepClone() : null;

    /// <summary>A gate validates an object against its action's schema.</summary>
    public static JsonObject GateInput(JsonNode? value) =>
        value is JsonObject o ? (JsonObject)o.DeepClone() : new JsonObject { ["input"] = value?.DeepClone() };

    /// <summary>A short, stable fingerprint of an input, for a call that carries no id. FNV-1a, as in Python.</summary>
    public static string Fingerprint(JsonNode? value)
    {
        var text = value?.ToJsonString() ?? "null";
        uint h = 0x811C9DC5;
        foreach (var ch in text)
        {
            h ^= ch;
            h = unchecked(h * 0x01000193);
        }
        return h.ToString("x", System.Globalization.CultureInfo.InvariantCulture);
    }

    public static string MaxRounds(int rounds) =>
        $"The run was still waiting for approval after {rounds} rounds; stopping rather than asking forever.";
}
