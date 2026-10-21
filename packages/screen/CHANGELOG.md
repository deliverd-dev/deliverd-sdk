# Changelog

## 0.1.0

The first release. The detectors Deliverd's SDKs already ran, published on
their own to run with no account and no network: `screen()` with local
verdicts, redaction with placeholders that `restore()` reverses, adapters for
a Hugging Face token classifier and for Presidio so a model can find people's
names, and a CLI for pre-commit hooks and CI.
This package also includes Vercel AI SDK middleware (`@deliverd/screen/ai-sdk`) and a local
MCP server (`npx @deliverd/screen mcp`, one tool: `screen_text`).
