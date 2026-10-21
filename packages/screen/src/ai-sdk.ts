/**
 * The check as Vercel AI SDK middleware: every call through the wrapped model
 * is screened first, the whole conversation at once.
 *
 * ```ts
 * import { wrapLanguageModel, generateText } from "ai";
 * import { screenMiddleware } from "@deliverd/screen/ai-sdk";
 *
 * const model = wrapLanguageModel({ model: openai("gpt-5"), middleware: screenMiddleware() });
 * const { text } = await generateText({ model, prompt });
 * ```
 *
 * What the model may not receive is replaced by placeholders before it is
 * sent, and the model's answer has the values put back, streamed or not. A
 * `deny`, or an `ask` (nobody here can answer one), throws `ScreenBlockedError`
 * and the model is never called.
 *
 * Screened: system prompts and the text parts of user and assistant messages,
 * which is where pasted records, retrieved documents and earlier answers sit.
 * Files, images, tool calls and tool results are passed through as they are.
 *
 * No dependency on `ai`: the middleware is typed by shape, so it fits
 * `wrapLanguageModel` in AI SDK 7 (`v4`, the default) and 6 (`v3`).
 */

import { restore } from "./data-screen.js";
import { screen, type Screened, type ScreenOptions } from "./index.js";

export class ScreenBlockedError extends Error {
  constructor(readonly screened: Screened) {
    super(`Not sent to the model: ${screened.reasons.join(" ")}`);
    this.name = "ScreenBlockedError";
  }
}

export interface ScreenMiddlewareOptions extends ScreenOptions {
  /** The AI SDK middleware specification. Default `v4` (AI SDK 7); `v3` for AI SDK 6. */
  specificationVersion?: "v3" | "v4";
  /** Called with every result, to log or count it. */
  onScreened?: (screened: Screened) => void;
}

interface TextPart {
  type: string;
  text?: string;
}
interface Message {
  role: string;
  content: string | TextPart[];
}
interface CallParams {
  prompt: Message[];
}
interface GenerateResult {
  content: { type: string; text?: string }[];
}
interface StreamPart {
  type: string;
  delta?: string;
  id?: string;
}

/**
 * Between the texts of one conversation while it is screened as one, so a
 * value has one placeholder throughout. No detector matches it, and a span
 * across it is dropped before the check.
 */
const SEP = "\n␞\n";

const replacementsFor = new WeakMap<object, Readonly<Record<string, string>>>();

/** Placeholders are `[WORD_N]`: an unclosed `[` with only these after it may still become one. */
const PARTIAL = /\[[A-Z0-9_]{0,40}$/;

export function screenMiddleware(options: ScreenMiddlewareOptions = {}) {
  const { specificationVersion = "v4", onScreened, ...screenOptions } = options;

  return {
    specificationVersion,

    async transformParams({ params }: { type: "generate" | "stream"; params: CallParams }): Promise<CallParams> {
      // Where every screened text sits, in the order it is joined.
      const slots: { message: number; part: number | null }[] = [];
      const texts: string[] = [];
      params.prompt.forEach((m, i) => {
        if (typeof m.content === "string") {
          if (m.role === "system") {
            slots.push({ message: i, part: null });
            texts.push(m.content);
          }
          return;
        }
        if (m.role !== "user" && m.role !== "assistant") return;
        m.content.forEach((p, j) => {
          if (p.type === "text" && typeof p.text === "string") {
            slots.push({ message: i, part: j });
            texts.push(p.text);
          }
        });
      });
      if (texts.length === 0) return params;

      const joined = texts.join(SEP);
      const bounds: number[] = [];
      let at = 0;
      for (const t of texts) {
        at += t.length;
        bounds.push(at);
        at += SEP.length;
      }
      const crosses = (s: { start: number; end: number }) => bounds.some((b) => s.start < b + SEP.length && s.end > b);
      const spans = [...(screenOptions.spans ?? [])];
      for (const d of screenOptions.detectors ?? []) spans.push(...(await d(joined)));

      const screened = await screen(joined, { ...screenOptions, detectors: [], spans: spans.filter((s) => !crosses(s)) });
      onScreened?.(screened);
      if (!screened.allowed || screened.text === null) throw new ScreenBlockedError(screened);
      if (screened.verdict === "allow") return params;

      const parts = screened.text.split(SEP);
      if (parts.length !== texts.length) throw new ScreenBlockedError({ ...screened, verdict: "deny", allowed: false, text: null });
      const prompt = params.prompt.map((m) => (typeof m.content === "string" ? { ...m } : { ...m, content: m.content.map((p) => ({ ...p })) }));
      slots.forEach((slot, k) => {
        const m = prompt[slot.message]!;
        if (slot.part === null) m.content = parts[k]!;
        else (m.content as TextPart[])[slot.part]!.text = parts[k]!;
      });
      const next = { ...params, prompt };
      // The replacements, for the answer: found again by the params object the
      // AI SDK hands back to wrapGenerate and wrapStream.
      replacementsFor.set(next, screened.replacements);
      return next;
    },

    async wrapGenerate({ doGenerate, params }: { doGenerate: () => PromiseLike<GenerateResult>; params: CallParams }) {
      const result = await doGenerate();
      const replacements = replacementsFor.get(params);
      if (!replacements) return result;
      return {
        ...result,
        content: result.content.map((c) => (c.type === "text" && typeof c.text === "string" ? { ...c, text: restore(c.text, replacements) } : c)),
      };
    },

    async wrapStream<R extends { stream: ReadableStream<StreamPart> }>({ doStream, params }: { doStream: () => PromiseLike<R>; params: CallParams }) {
      const result = await doStream();
      const replacements = replacementsFor.get(params);
      if (!replacements) return result;
      return { ...result, stream: result.stream.pipeThrough(restoringStream(replacements)) };
    },
  };
}

/**
 * Put values back into streamed text. A placeholder can arrive split across
 * deltas (`[EMA`, `IL_1]`), so text from an unclosed `[` is held until it
 * closes or cannot be one, per text block.
 */
export function restoringStream(replacements: Readonly<Record<string, string>>): TransformStream<StreamPart, StreamPart> {
  const held = new Map<string, string>();
  const flush = (id: string, controller: TransformStreamDefaultController<StreamPart>) => {
    const rest = held.get(id);
    if (rest) controller.enqueue({ type: "text-delta", id, delta: restore(rest, replacements) });
    held.delete(id);
  };
  return new TransformStream<StreamPart, StreamPart>({
    transform(part, controller) {
      if (part.type === "text-delta" && typeof part.delta === "string") {
        const id = part.id ?? "";
        const text = (held.get(id) ?? "") + part.delta;
        const partial = PARTIAL.exec(text);
        const ready = partial ? text.slice(0, partial.index) : text;
        held.set(id, partial ? partial[0] : "");
        if (ready) controller.enqueue({ ...part, delta: restore(ready, replacements) });
        return;
      }
      if (part.type === "text-end") flush(part.id ?? "", controller);
      if (part.type === "finish") for (const id of [...held.keys()]) flush(id, controller);
      controller.enqueue(part);
    },
    flush(controller) {
      for (const id of [...held.keys()]) flush(id, controller);
    },
  });
}
