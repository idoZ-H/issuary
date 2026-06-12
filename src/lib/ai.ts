import Anthropic from "@anthropic-ai/sdk";
import { wrapAnthropic } from "langsmith/wrappers/anthropic";
import { Client as LangSmithClient } from "langsmith";
import { CLASSIFICATION_TYPES, SEVERITIES } from "../types";

type FetchLike = typeof fetch;

// Lazy LangSmith client — created on first use, after the env bridge has run.
// Making it lazy is what lets us pick up bridged process.env values that
// weren't available when this module was first loaded. We pass this explicit
// client to wrapAnthropic and traceable so we can flush its queue from the
// fetch handler via ctx.waitUntil(); the default singleton uses a separate
// queue we can't reach.
let _lsClient: LangSmithClient | undefined;
let _lsTried = false;

export function getLangSmithClient(): LangSmithClient | undefined {
  if (_lsTried) return _lsClient;
  _lsTried = true;
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  if (!env?.LANGSMITH_API_KEY) return undefined;
  _lsClient = new LangSmithClient({
    apiKey: env.LANGSMITH_API_KEY,
    apiUrl: env.LANGSMITH_ENDPOINT ?? "https://api.smith.langchain.com",
  });
  return _lsClient;
}

const GEMINI_MODEL = "gemini-2.5-flash";
const CLAUDE_MODEL = "claude-opus-4-8";
// Bumped 4096 → 8192 after a live Sonnet truncation, then 8192 → 12288 with the
// Opus 4.8 migration. The final turn spends max_tokens on adaptive thinking AND
// the English structured body (Summary / Steps / Expected / Actual /
// Investigation / file citations); at effort "high" Opus thinks more deeply
// than Sonnet did, and Opus's tokenizer counts ~5-15% higher, so the old 8192
// left too little headroom before the JSON gets cut mid-string (truncation
// arrives as stop_reason "max_tokens" and fails the loop). 12288 keeps us
// comfortably under the ~16K non-streaming SDK timeout ceiling.
const CLAUDE_MAX_TOKENS = 12288;

// JSON schema for the classifier's final text turn. Passed via
// output_config.format (structured outputs, GA on Opus 4.8 — no beta header).
// The API constrains ONLY the final text turn; tool-use turns are unaffected,
// so the multi-turn classifier loop in classifier.ts still calls tools freely.
// The type/severity enums come from the single-source-of-truth arrays in
// types.ts; a drift test in lib-ai-claude.test.ts pins them.
//
// Structured outputs guarantees valid, fence-free, schema-conformant JSON when
// the turn COMPLETES (stop_reason "end_turn") — so classifier.ts no longer
// hand-validates enums or strips code fences. It does NOT prevent truncation:
// an over-budget response comes back as stop_reason "max_tokens" (not
// "end_turn"), which the classifier loop reports as an error before any parse.
// JSON schema also can't express "non-empty string" (no minLength), so the
// non-empty guards on client_reply_he / title_en / body_he stay post-parse.
export const CLASSIFIER_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "should_create_issue",
    "is_followup_to_issue",
    "type",
    "severity",
    "title_en",
    "body_he",
    "suggested_labels",
    "sensitive",
    "client_reply_he",
  ],
  properties: {
    should_create_issue: { type: "boolean" },
    is_followup_to_issue: { anyOf: [{ type: "integer" }, { type: "null" }] },
    type: { type: "string", enum: [...CLASSIFICATION_TYPES] },
    severity: { type: "string", enum: [...SEVERITIES] },
    title_en: { type: "string" },
    body_he: { type: "string" },
    suggested_labels: { type: "array", items: { type: "string" } },
    sensitive: { type: "boolean" },
    client_reply_he: { type: "string" },
  },
} as const;

export async function transcribeWithGemini(
  audio: ArrayBuffer,
  mimeType: string,
  apiKey: string,
  fetcher: FetchLike = fetch
): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;
  const bytes = new Uint8Array(audio);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  const b64 = btoa(bin);

  const body = {
    contents: [
      {
        role: "user",
        parts: [
          { text: "Transcribe this audio verbatim. Return only the transcription, no preamble." },
          { inline_data: { mime_type: mimeType, data: b64 } },
        ],
      },
    ],
  };

  const res = await fetcher(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`gemini transcription failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  const text = json?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("gemini returned no transcription");
  return text.trim();
}

export interface ClassifyArgs {
  system: Anthropic.TextBlockParam[];
  userTurns: Anthropic.MessageParam[];
  tools: Anthropic.Tool[];
}

export class ClaudeClient {
  constructor(public readonly sdk: Anthropic) {}

  static fromApiKey(apiKey: string): ClaudeClient {
    // wrapAnthropic patches messages.create / parse / stream (and the beta
    // namespace) to emit LangSmith spans. We pass our explicit lazy client
    // so we can flush its queue from the fetch handler — without that,
    // run-end PATCHes get cancelled when the Worker isolate is reaped.
    const raw = new Anthropic({ apiKey });
    const lsClient = getLangSmithClient();
    const wrapOpts = lsClient ? { client: lsClient } : {};
    return new ClaudeClient(wrapAnthropic(raw, wrapOpts as never));
  }

  async classify(args: ClassifyArgs): Promise<Anthropic.Message> {
    return await this.sdk.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: CLAUDE_MAX_TOKENS,
      // Adaptive thinking + medium effort are forward-compatible fields the SDK
      // version pinned in package.json doesn't yet type; cast keeps typecheck happy
      // while still passing the values through to the API.
      thinking: { type: "adaptive" },
      // effort tunes thinking depth; format constrains the final text turn to
      // the classifier schema (structured outputs). Both ride in output_config.
      // "high" is the recommended minimum for intelligence-sensitive triage on
      // Opus 4.8 (bug-vs-feature, ask-vs-guess, code grounding). Opus 4.8
      // respects effort more strictly than Sonnet — "medium" measurably
      // under-thinks the harder judgment calls here.
      output_config: {
        effort: "high",
        format: { type: "json_schema", schema: CLASSIFIER_OUTPUT_SCHEMA },
      },
      system: args.system,
      messages: args.userTurns,
      tools: args.tools,
      tool_choice: { type: "auto" },
    } as unknown as Anthropic.MessageCreateParamsNonStreaming);
  }
}
