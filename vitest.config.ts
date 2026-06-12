import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";
import path from "node:path";

export default defineWorkersConfig({
  resolve: {
    // Alias langsmith subpaths to local stubs in tests. The real package
    // transitively imports node:fs/promises, which vitest-pool-workers does
    // not surface even with nodejs_compat enabled. Production works fine —
    // wrangler/esbuild picks langsmith's browser build via package.json
    // exports. This alias only affects vitest.
    alias: {
      "langsmith/wrappers/anthropic": path.resolve(__dirname, "./tests/stubs/langsmith-anthropic.ts"),
      "langsmith/traceable": path.resolve(__dirname, "./tests/stubs/langsmith-traceable.ts"),
      langsmith: path.resolve(__dirname, "./tests/stubs/langsmith.ts"),
    },
  },
  test: {
    exclude: ["**/node_modules/**", "**/.worktrees/**", "**/.claude/**"],
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.test.toml" },
        miniflare: {
          kvNamespaces: [
            "CLIENTS", "ADMINS", "REPO_CONTEXT", "RECENT_ACTIVITY",
            "PENDING_CLASSIFICATION", "RATE_LIMITS", "ISSUE_TO_CHAT", "DEDUP",
            "ADMIN_SESSIONS", "ISSUE_LIST_CACHE", "CONVERSATION_HISTORY",
            "CODE_INDEX_META",
          ],
        },
      },
    },
  },
});
