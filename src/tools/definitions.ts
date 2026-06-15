import type Anthropic from "@anthropic-ai/sdk";

// MUST stay alphabetically sorted by name and stable across requests — this
// list is part of the cached prompt prefix; reordering invalidates cache.
export const CLASSIFIER_TOOLS: Anthropic.Tool[] = [
  {
    name: "ask_clarifying_question",
    description:
      "Pause classification and send a single Hebrew question to the client. Use ONLY when the message is genuinely ambiguous and the answer will materially change the issue type, severity, or affected area. Do NOT use to ask politeness questions, to confirm details that are clear from context, or when the message is non-actionable chitchat. You may call this tool at most once per ticket — calling it commits to using the client's reply as the final disambiguating signal. After this tool is called, do not produce a final classification on this turn; the worker will pause the loop and resume on the next user message.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        question_he: {
          type: "string",
          description:
            "The Hebrew question to send to the client. Keep it specific and answerable in one short reply. Example: 'תוכל להבהיר אם הבעיה בייצוא של הדשבורד או של הדוחות?'",
        },
        reason_en: {
          type: "string",
          description:
            "Brief English explanation of why this question is necessary. Logged for observability and prompt iteration; never shown to the client.",
        },
      },
      required: ["question_he", "reason_en"],
    },
    strict: true,
  } as unknown as Anthropic.Tool,
  {
    name: "github_read_file",
    description:
      "Read a specific file from the client's repo when its content is genuinely needed to clarify the issue (e.g. confirming a function signature, checking a README section, verifying which export is referenced). Use sparingly — most issues do not require this. Only call after github_search_code has identified a strong candidate, or when the user's message names a file path explicitly. Returns up to 10 KB of file content; longer files are truncated.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: {
          type: "string",
          description:
            "File path relative to repo root, e.g. 'src/components/Dashboard.tsx'. Must be a path returned by github_search_code or explicitly mentioned in the user's report — do not guess paths.",
        },
      },
      required: ["path"],
    },
    strict: true,
  } as unknown as Anthropic.Tool,
  {
    name: "github_search_code",
    description:
      "Search source code in the current client's GitHub repository to find files relevant to the user's report. Call this whenever the message names a concrete code anchor — a UI element name (e.g. 'export button'), an error message fragment, a function or class name, a page path, or a file extension — and you are about to cite a file: confirm the real path with a search rather than guessing from the directory listing. The search is cheap and a path grounded in a real result is materially more useful to the developer, so err toward calling it. Skip it only for purely conceptual feature requests with no anchor (e.g. 'add dark mode'). The body of the issue you produce should cite the file paths returned by this tool. Returns up to 5 file matches: path, ~200-char snippet, and GitHub URL.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: {
          type: "string",
          description:
            "Keyword query for GitHub's literal code search — keywords drawn directly from the user's report. Examples: 'export button', 'Dashboard.tsx', 'project page', 'TypeError: Cannot read properties of undefined'. Prefer 1-3 words; GitHub code search rewards specificity over verbosity.",
        },
        semantic_query: {
          type: "string",
          description:
            "A ONE-SENTENCE natural-language description of the code or behavior you expect to find — written as if describing the relevant source file, not as keywords. This drives the semantic (embedding-based) search, which matches meaning rather than exact tokens and is far more reliable than GitHub code search on private repos. Describe the mechanism, e.g. 'the function that sends the WhatsApp agency-quote message to the group after a lead is created' rather than 'whatsapp agency'. Phrasing it as a hypothetical code description (HyDE) materially improves retrieval.",
        },
      },
      required: ["query", "semantic_query"],
    },
    strict: true,
  } as unknown as Anthropic.Tool,
  {
    name: "github_search_issues",
    description:
      "Search existing issues to detect duplicates and follow-ups before creating a new issue. Call this whenever the message could overlap with prior work — a status check ('any update on X?'), repeated symptoms of a known problem, or wording that matches an item in RECENT OPEN ISSUES in the system prompt. This is the only way to catch a duplicate, so when in doubt, search. Skip it only for clearly fresh reports unrelated to anything recent. If a strong match is found, set is_followup_to_issue in your final output instead of creating a duplicate. Returns up to 5 issues: number, title, state, labels, last-updated, URL.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: {
          type: "string",
          description: "Search query — keywords from the user's report. Example: 'export dashboard'.",
        },
        state: {
          type: "string",
          enum: ["open", "closed", "all"],
          description:
            "Issue state filter. Use 'open' for follow-up detection on active problems (default choice). Use 'all' when checking historical context for a repeat issue.",
        },
      },
      required: ["query", "state"],
    },
    strict: true,
  } as unknown as Anthropic.Tool,
];
