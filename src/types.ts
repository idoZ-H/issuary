// All shared types used across the worker. Keep this file flat and additive —
// every new module reads from here, so type renames cascade.

// Hard ceiling on clarifying questions across ALL turns of one ticket. Lives
// here (dependency-free) so the dispatcher (enforcement) and the classifier
// prompt builder (the model-facing instruction) share one source of truth —
// if this changes, both the cap and what the model is told change together.
export const MAX_TICKET_CLARIFICATIONS = 2;

export interface ProjectRecord {
  id: string;                  // slug, unique within this client; e.g. "acme-core"
  name_he: string;             // display name in Hebrew; e.g. "אקמי קור"
  repo: string;                // "owner/repo"
  created_at: string;          // ISO8601
  semantic_enabled?: boolean;  // when false, skip code-index build + retrieval for this project (default: on)
}

export interface ClientRecord {
  name: string;
  telegram_chat_id: number;
  active: boolean;
  created_at: string;          // ISO8601
  shadow_mode?: boolean;       // when true, Ido gets a copy of raw msg + classifier output
  projects: ProjectRecord[];      // length ≥ 1
  active_project_id: string;      // must reference an id in projects[]
  default_project_id: string;     // used on first DM and as fallback after removal
  welcomed_multi_at?: string;     // ISO8601; set after the one-time multi-project onboarding DM
}

// Legacy on-disk shape — only present in the read path for backwards-compat.
export interface LegacyClientRecord {
  name: string;
  repo: string;                // "owner/repo"
  telegram_chat_id: number;
  active: boolean;
  created_at: string;
  shadow_mode?: boolean;
}

export interface AdminRecord {
  role: "admin";
}

export interface RepoContext {
  tree: string;              // top-level directory listing, joined by "\n"
  readme: string;            // truncated to ~3 KB
  recent_issues: Array<{ number: number; title: string; labels: string[]; state: "open" | "closed" }>;
  fetched_at: string;
}

// Per-repo manifest tracking the freshness and chunker version of the code
// index. Stored in CODE_INDEX_META KV. Freshness is computed from fetched_at
// (not a KV TTL) so a stale manifest still signals "rebuild" rather than
// disappearing and looking like a never-indexed repo.
export interface CodeIndexManifest {
  repo: string;
  fetched_at: string;     // ISO8601 — on a "complete" manifest this is the completion time
  chunk_count: number;    // cumulative chunks indexed so far
  chunker_version: string;
  status: "building" | "complete";
  cursor: number;         // index of the next file to process; equals paths.length when fully indexed
  paths: string[];        // file list captured once at build start
  // Incremental-update bookkeeping (optional → backward-compatible with pre-existing manifests).
  file_shas?: Record<string, string>;     // path → git blob SHA (content hash)
  file_chunks?: Record<string, number[]>; // path → chunk start_lines (to derive vector ids for deletes)
  head_sha?: string;                       // last indexed commit SHA
}

// A code chunk returned from semantic retrieval, shaped for the classifier.
// One durable outcome record per classification — the owned, queryable memory
// of what the classifier saw, did, and how well it could ground its answer.
// Stored in the (optional) CLASSIFICATIONS KV namespace. Volume is low, so the
// admin view lists and sorts in-process.
export interface ClassificationRecord {
  ts: string;                          // ISO timestamp (caller-supplied, sortable)
  tg_user_id: number;
  reporter_name: string;
  repo: string;
  project_id: string;
  user_text: string;
  result_kind: "final" | "clarify" | "error";
  type?: string;
  severity?: string;
  should_create_issue?: boolean;
  is_followup_to_issue?: number | null;
  issue_number?: number;
  // Retrieval grounding (from ToolDispatcher.getGrounding()).
  github_search_calls: number;
  github_total_matches: number;
  semantic_calls: number;
  top_semantic_score: number | null;
  low_grounding: boolean;
  // Spend.
  input_tokens: number;
  output_tokens: number;
  cost_cents: number;
}

export interface RetrievedChunk {
  path: string;
  start_line: number;
  end_line: number;
  snippet: string;
  score: number;
}

export interface RecentActivity {
  issue_url: string;
  repo: string;
  issue_number: number;
  last_message_at: string;
}

export interface PendingClassification {
  raw_message_id: number;
  raw_message_text: string;
  attachments: AttachmentRef[];
  asked_question_he: string;
  asked_at: string;
  // Number of clarifying questions already asked across this ticket's turns.
  // Optional: legacy KV records and some test fixtures omit it — read with `?? 0`.
  questions_asked?: number;
}

export interface AttachmentRef {
  kind: "photo" | "voice" | "video" | "document";
  telegram_file_id: string;
  signed_url?: string;       // populated after GCS upload
  transcription?: string;    // for voice
  size_bytes?: number;
}

export interface IssueToChat {
  tg_user_id: number;
  telegram_chat_id: number;
  langsmith_run_id?: string;
}

export interface AdminSession {
  tg_user_id: number;
  created_at: string;
}

export interface AdminLoginToken {
  tg_user_id: number;
  created_at: string;
}

export interface ConversationTurn {
  role: "user" | "assistant";
  text: string;
  ts: string;
}

export interface ConversationHistory {
  turns: ConversationTurn[];
  updated_at: string;
}

// Single source of truth for the classifier's enum domains. The ClassificationType
// / Severity unions are DERIVED from these arrays, and src/lib/ai.ts builds the
// structured-output JSON-schema enums from the same arrays — so the union, the
// schema, and any runtime list stay in lockstep by construction. Add a value
// here and it propagates everywhere; a drift test in lib-ai-claude.test.ts pins
// the literal values.
export const CLASSIFICATION_TYPES = ["bug", "feature", "question", "chitchat", "out_of_scope"] as const;
export const SEVERITIES = ["low", "med", "high", "critical"] as const;
export type ClassificationType = (typeof CLASSIFICATION_TYPES)[number];
export type Severity = (typeof SEVERITIES)[number];

export interface ClassifierOutput {
  should_create_issue: boolean;
  is_followup_to_issue: number | null;
  type: ClassificationType;
  severity: Severity;
  title_en: string;
  body_he: string;
  suggested_labels: string[];
  sensitive: boolean;
  client_reply_he: string;
}

interface KnownBindings {
  // KV
  CLIENTS: KVNamespace;
  ADMINS: KVNamespace;
  REPO_CONTEXT: KVNamespace;
  RECENT_ACTIVITY: KVNamespace;
  PENDING_CLASSIFICATION: KVNamespace;
  CONVERSATION_HISTORY: KVNamespace;
  RATE_LIMITS: KVNamespace;
  ISSUE_TO_CHAT: KVNamespace;
  DEDUP: KVNamespace;
  ADMIN_SESSIONS: KVNamespace;
  ISSUE_LIST_CACHE: KVNamespace;
  CODE_INDEX_META: KVNamespace; // per-repo code-index freshness manifest
  // Durable per-classification outcome record (durable observability layer).
  // OPTIONAL: writes are best-effort and skipped when the binding is absent, so
  // the code ships safely before the namespace is provisioned. To activate:
  // create the namespace and add the binding to the gitignored wrangler.toml.
  CLASSIFICATIONS?: KVNamespace;
  // Workers AI + Vectorize for semantic code retrieval
  AI: Ai;
  CODE_INDEX: Vectorize;
  // Secrets
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  GITHUB_WEBHOOK_SECRET: string;
  ANTHROPIC_API_KEY: string;
  GEMINI_API_KEY: string;
  GCS_SERVICE_ACCOUNT_JSON: string;
  IDO_TG_USER_ID: string;          // "123456789"
  IDO_INBOX_CHAT_ID: string;       // "-100..." for private channel
  GCS_BUCKET: string;              // "workfluxs-feedback-media"
  GITHUB_APP_ID: string;           // numeric App ID from GitHub App settings
  GITHUB_APP_PRIVATE_KEY: string;  // PEM, including BEGIN/END markers and newlines
  // LangSmith tracing — all optional. If LANGSMITH_API_KEY is unset, tracing is
  // a no-op. We bridge these to process.env at the start of every fetch so
  // langsmith's env-based config picks them up inside the Worker isolate.
  LANGSMITH_TRACING?: string;          // "true" enables tracing
  LANGSMITH_API_KEY?: string;
  LANGSMITH_ENDPOINT?: string;         // defaults to https://api.smith.langchain.com
  LANGSMITH_PROJECT?: string;          // defaults to "feedback-bot"
  LANGSMITH_TRACING_BACKGROUND?: string; // "false" forces sync flush in serverless
  LANGSMITH_ORG_SLUG?: string;           // for /admin issues feed deep links to traces
  // Cloudflare GraphQL Analytics — optional. Powers the admin index-status usage
  // panel (neurons vs free tier, KV op counts). Absent → panel degrades to
  // "not configured".
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_ANALYTICS_TOKEN?: string;
}

export type Env = KnownBindings;
