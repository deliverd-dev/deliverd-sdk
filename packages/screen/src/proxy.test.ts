import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { restorer, screenRequestBody, startProxy, textSlots } from "./proxy.js";

const servers: Server[] = [];
afterEach(() => servers.splice(0).forEach((s) => s.close()));

/** A model API that echoes what it was sent, as JSON or as server-sent events. */
async function fakeUpstream(): Promise<{ url: string; seen: string[] }> {
  const seen: string[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    seen.push(body);
    const said = JSON.parse(body).messages.at(-1).content as string;
    if (JSON.parse(body).stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      // Split the answer mid-placeholder, as a real stream may.
      const answer = `I wrote to ${said.slice(said.indexOf("["))}`;
      const cut = answer.indexOf("[") + 3;
      res.write(`data: ${JSON.stringify({ delta: answer.slice(0, cut) })}\n\n`);
      res.end(`data: ${JSON.stringify({ delta: answer.slice(cut) })}\n\n`);
      return;
    }
    res.writeHead(200, { "content-type": "application/json", authorization: "never-forwarded-back" });
    res.end(JSON.stringify({ choices: [{ message: { content: `Echo: ${said}` } }], auth: req.headers.authorization }));
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

async function proxyTo(upstream: string) {
  const server = await startProxy({ upstream, port: 0 });
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("the screening proxy", () => {
  it("finds the text in OpenAI, Anthropic and Responses bodies, and nothing else", () => {
    const body = {
      model: "gpt-x",
      system: "Be brief",
      messages: [{ role: "user", content: "hi" }, { role: "user", content: [{ type: "text", text: "there" }] }],
      input: [{ type: "message", content: [{ type: "input_text", text: "again" }] }],
      temperature: 0,
    };
    expect(textSlots(body).map((s) => (s.holder as Record<string | number, string>)[s.key])).toEqual(["Be brief", "hi", "there", "again"]);
  });

  it("redacts across messages with one numbering, so one value is one placeholder", async () => {
    const out = await screenRequestBody(
      JSON.stringify({ messages: [{ content: "mary@example.ie" }, { content: "again mary@example.ie, and joe@example.ie" }] })
    );
    expect(out.verdict).toBe("redact");
    expect(JSON.parse(out.body!).messages.map((m: { content: string }) => m.content)).toEqual(["[EMAIL_1]", "again [EMAIL_1], and [EMAIL_2]"]);
  });

  it("forwards a redacted request with its headers, and puts the values back in the answer", async () => {
    const up = await fakeUpstream();
    const proxy = await proxyTo(up.url);
    const res = await fetch(`${proxy}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer sk-test" },
      body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "Write to mary@example.ie" }] }),
    });
    const answer = (await res.json()) as { choices: { message: { content: string } }[]; auth: string };
    expect(JSON.parse(up.seen[0]!).messages[0].content).toBe("Write to [EMAIL_1]");
    expect(answer.auth).toBe("Bearer sk-test");
    expect(answer.choices[0]!.message.content).toBe("Echo: Write to mary@example.ie");
  });

  it("restores a placeholder split across two streamed chunks", async () => {
    const up = await fakeUpstream();
    const proxy = await proxyTo(up.url);
    const res = await fetch(`${proxy}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stream: true, messages: [{ role: "user", content: "Mail [x] mary@example.ie" }] }),
    });
    const text = await res.text();
    const said = text
      .split("\n")
      .filter((l) => l.startsWith("data: "))
      .map((l) => JSON.parse(l.slice(6)).delta)
      .join("");
    expect(said).toBe("I wrote to [x] mary@example.ie");
    expect(text).not.toContain("[EMAIL_1]");
  });

  it("sends nothing for a secret, and says why in an error clients print", async () => {
    const up = await fakeUpstream();
    const proxy = await proxyTo(up.url);
    const res = await fetch(`${proxy}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "key AKIAABCDEFGHIJKLMNOP" }] }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { type: string; message: string } };
    expect(body.error.type).toBe("deliverd_screen_deny");
    expect(body.error.message).toMatch(/secret/);
    expect(up.seen).toHaveLength(0);
  });

  it("holds back only what could start a placeholder", () => {
    const r = restorer({ "[EMAIL_1]": 'a"b@x.ie' });
    expect(r.push("see [EM") + r.push("AIL_1] and [x]") + r.end()).toBe('see a\\"b@x.ie and [x]');
    const none = restorer({});
    expect(none.push("[EM")).toBe("[EM");
  });
});
