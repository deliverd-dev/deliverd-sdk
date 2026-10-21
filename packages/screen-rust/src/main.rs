//! deliverd-screen: the check from a terminal, a pre-commit hook or CI.
//!
//! ```text
//! deliverd-screen notes.txt                    what is in it
//! cat prompt.txt | deliverd-screen --redact    the text with it replaced
//! deliverd-screen --fail fixtures/*.json       exit 1 if anything is found
//! deliverd-screen mcp                          a local MCP server over stdio
//! ```
//!
//! Reads files, or standard input when there are none. Nothing is sent
//! anywhere. The same commands as `npx @deliverd/screen` and the Python
//! `deliverd-screen`.

use std::io::{self, BufRead, Write};
use std::process::ExitCode;

use deliverd_screen::{describe_counts, redact, Classification, Counts, Finding, Screen, Term, VERSION};
use serde_json::{json, Map, Value};

fn help() -> String {
    format!(
        "deliverd-screen {VERSION}: find personal data, secrets and confidential terms in text before it goes to an AI model.

Usage:
  deliverd-screen [options] [file...]   check files, or standard input
  deliverd-screen mcp                   run a local MCP server over stdio

Options:
  --redact         print the text with what was found replaced by placeholders (one input)
  --json           print what was found as JSON: kinds, offsets and counts, never values
  --fail           exit 1 when anything is found (for pre-commit hooks and CI)
  --terms <file>   your own words not to send, one per line
  -h, --help       this help
  -v, --version    the version

Runs locally. Nothing is sent anywhere. A net, not a guarantee: names are not
found unless you plug in a model (see the README)."
    )
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match run(&args, &mut io::stdin().lock(), &mut io::stdout().lock(), &mut io::stderr().lock()) {
        Ok(code) => ExitCode::from(code),
        Err(e) => {
            eprintln!("{e}");
            ExitCode::from(2)
        }
    }
}

fn counts_json(counts: &Counts) -> Value {
    Value::Object(counts.iter().map(|(k, n)| (k.key().to_string(), json!(n))).collect::<Map<_, _>>())
}

fn findings_json(findings: &[Finding]) -> Value {
    findings.iter().map(|f| json!({ "kind": f.kind.key(), "label": f.label, "start": f.start, "end": f.end })).collect()
}

fn run(args: &[String], stdin: &mut impl BufRead, stdout: &mut impl Write, stderr: &mut impl Write) -> io::Result<u8> {
    if args.first().map(String::as_str) == Some("mcp") {
        serve(stdin, stdout)?;
        return Ok(0);
    }
    let mut files: Vec<&str> = vec![];
    let (mut redact_out, mut as_json, mut fail_on_find) = (false, false, false);
    let mut terms: Vec<Term> = vec![];
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "-h" | "--help" => {
                writeln!(stdout, "{}", help())?;
                return Ok(0);
            }
            "-v" | "--version" => {
                writeln!(stdout, "{VERSION}")?;
                return Ok(0);
            }
            "--redact" => redact_out = true,
            "--json" => as_json = true,
            "--fail" => fail_on_find = true,
            "--terms" => {
                i += 1;
                let Some(path) = args.get(i) else {
                    writeln!(stderr, "--terms needs a file.")?;
                    return Ok(2);
                };
                terms = std::fs::read_to_string(path)?
                    .lines()
                    .map(str::trim)
                    .filter(|t| !t.is_empty() && !t.starts_with('#'))
                    .map(Term::new)
                    .collect();
            }
            a if a.starts_with('-') && a != "-" => {
                writeln!(stderr, "Unknown option {a}. See --help.")?;
                return Ok(2);
            }
            a => files.push(a),
        }
        i += 1;
    }
    if redact_out && files.len() > 1 {
        writeln!(stderr, "--redact takes one input.")?;
        return Ok(2);
    }

    let inputs: Vec<(String, String)> = if files.is_empty() || files == ["-"] {
        let mut text = String::new();
        stdin.read_to_string(&mut text)?;
        vec![("stdin".to_string(), text)]
    } else {
        files.iter().map(|f| Ok((f.to_string(), std::fs::read_to_string(f)?))).collect::<io::Result<_>>()?
    };
    let screen = Screen::new().terms(terms);
    let mut found = 0;
    let mut report = vec![];
    for (name, text) in &inputs {
        let (findings, counts) = screen.detect(text, &[]);
        found += findings.len();
        if redact_out {
            write!(stdout, "{}", redact(text, &findings).text)?;
        }
        if as_json {
            report.push(json!({ "file": name, "counts": counts_json(&counts), "findings": findings_json(&findings) }));
        } else if !findings.is_empty() {
            writeln!(stderr, "{name}: {}", describe_counts(&counts))?;
        }
    }
    if as_json {
        let out = if report.len() == 1 { report.remove(0) } else { Value::Array(report) };
        writeln!(stdout, "{}", serde_json::to_string_pretty(&out)?)?;
    } else if found == 0 && !redact_out {
        writeln!(stderr, "Nothing found.")?;
    }
    Ok(if fail_on_find && found > 0 { 1 } else { 0 })
}

// ── MCP ───────────────────────────────────────────────────────────────────
//
// A local MCP server with one tool, `screen_text`, so an agent in Claude
// Code, Cursor or Codex can check text before it pastes it anywhere. MCP over
// stdio, one JSON-RPC message per line, and nothing else: no network, no
// account. The tool returns the verdict, the counts and the redacted text,
// never the values it replaced, so the originals do not enter the agent's
// context through it.

const PROTOCOL_VERSIONS: [&str; 4] = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

fn tool() -> Value {
    json!({
        "name": "screen_text",
        "description": "Check text for personal data, secrets and confidential terms before sending it to a model, a tool or anyone else, and get back what may be sent. Runs locally; nothing leaves this machine. Use the returned text in place of the original. A net, not a guarantee: names are not reliably found.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "text": { "type": "string", "description": "The text to check." },
                "terms": { "type": "array", "items": { "type": "string" }, "description": "Your own words not to send: clients, code names." },
                "personalData": { "type": "boolean", "description": "Whether the destination may receive personal data. Default false." },
                "classification": {
                    "type": "string",
                    "enum": Classification::ALL.map(Classification::key),
                    "description": "The highest classification the destination may receive. Default internal."
                }
            },
            "required": ["text"]
        }
    })
}

/// The answer to one message, or `None` for a notification.
fn handle(req: &Value) -> Option<Value> {
    let id = req.get("id")?.clone();
    let reply = |result: Value| json!({ "jsonrpc": "2.0", "id": id, "result": result });
    let fail = |code: i64, message: String| json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } });
    let params = req.get("params").cloned().unwrap_or(Value::Null);
    Some(match req.get("method").and_then(Value::as_str).unwrap_or("") {
        "initialize" => {
            let asked = params.get("protocolVersion").and_then(Value::as_str).unwrap_or("");
            reply(json!({
                "protocolVersion": PROTOCOL_VERSIONS.iter().find(|v| **v == asked).unwrap_or(&PROTOCOL_VERSIONS[0]),
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "deliverd-screen", "version": VERSION }
            }))
        }
        "ping" => reply(json!({})),
        "tools/list" => reply(json!({ "tools": [tool()] })),
        "tools/call" => {
            let name = params.get("name").and_then(Value::as_str).unwrap_or("");
            if name != "screen_text" {
                return Some(fail(-32602, format!("Unknown tool: {name}")));
            }
            let args = params.get("arguments").cloned().unwrap_or(Value::Null);
            let Some(text) = args.get("text").and_then(Value::as_str) else {
                return Some(fail(-32602, "text is required.".to_string()));
            };
            let terms: Vec<Term> = args
                .get("terms")
                .and_then(Value::as_array)
                .map(|ts| ts.iter().filter_map(Value::as_str).map(Term::new).collect())
                .unwrap_or_default();
            let classification = args
                .get("classification")
                .and_then(Value::as_str)
                .and_then(Classification::from_key)
                .unwrap_or(Classification::Internal);
            let personal = args.get("personalData").and_then(Value::as_bool) == Some(true);
            let checked =
                Screen::new().model("the destination").allow(classification, personal).terms(terms).check(text);
            let summary = json!({
                "verdict": checked.verdict.key(),
                "allowed": checked.allowed,
                "found": describe_counts(&checked.counts),
                "counts": counts_json(&checked.counts),
                "reasons": checked.reasons,
                "text": checked.text,
            });
            reply(json!({
                "content": [{ "type": "text", "text": serde_json::to_string_pretty(&summary).unwrap_or_default() }],
                "structuredContent": summary,
                "isError": false
            }))
        }
        method => fail(-32601, format!("Method not found: {method}")),
    })
}

fn serve(input: &mut impl BufRead, output: &mut impl Write) -> io::Result<()> {
    for line in input.lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let answer = match serde_json::from_str::<Value>(&line) {
            Ok(req) => handle(&req),
            Err(_) => {
                Some(json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": "Parse error" } }))
            }
        };
        if let Some(answer) = answer {
            writeln!(output, "{answer}")?;
            output.flush()?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cli(args: &[&str], input: &str) -> (u8, String, String) {
        let args: Vec<String> = args.iter().map(|a| a.to_string()).collect();
        let (mut out, mut err) = (vec![], vec![]);
        let code = run(&args, &mut input.as_bytes(), &mut out, &mut err).unwrap();
        (code, String::from_utf8(out).unwrap(), String::from_utf8(err).unwrap())
    }

    #[test]
    fn redacts_standard_input() {
        let (code, out, err) = cli(&["--redact"], "Ring +353 87 123 4567");
        assert_eq!((code, out.as_str()), (0, "Ring [PHONE_1]"));
        assert_eq!(err, "stdin: 1 phone number\n");
    }

    #[test]
    fn fails_a_hook_when_something_is_found_and_never_prints_a_value() {
        let (code, out, _) = cli(&["--fail", "--json"], "mary@example.ie");
        assert_eq!(code, 1);
        assert!(!out.contains("mary"));
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["counts"], json!({ "email": 1 }));
    }

    #[test]
    fn passes_when_nothing_is_found() {
        assert_eq!(cli(&["--fail"], "nothing here").0, 0);
    }

    #[test]
    fn rejects_an_unknown_option() {
        assert_eq!(cli(&["--nope"], "").0, 2);
    }

    #[test]
    fn lists_and_runs_screen_text_without_the_values_it_replaced() {
        let list = handle(&json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" })).unwrap();
        assert_eq!(list["result"]["tools"][0]["name"], "screen_text");
        let call = handle(&json!({
            "jsonrpc": "2.0", "id": 2, "method": "tools/call",
            "params": { "name": "screen_text", "arguments": { "text": "Email mary@example.ie" } }
        }))
        .unwrap();
        assert_eq!(call["result"]["structuredContent"]["verdict"], "redact");
        assert_eq!(call["result"]["structuredContent"]["text"], "Email [EMAIL_1]");
        assert!(!call.to_string().contains("mary"));
    }

    #[test]
    fn answers_no_notification_and_says_when_a_line_is_not_json() {
        assert!(handle(&json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })).is_none());
        let mut out = vec![];
        serve(&mut "not json\n".as_bytes(), &mut out).unwrap();
        assert!(String::from_utf8(out).unwrap().contains("-32700"));
    }
}
