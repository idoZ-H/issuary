// Test stub for langsmith/wrappers/anthropic. The real package transitively
// imports node:fs/promises, which workerd doesn't surface in
// vitest-pool-workers even with nodejs_compat. wrapAnthropic in production
// works fine via langsmith's browser build; this stub keeps the SDK-level
// shape identical so tests don't touch tracing infrastructure.
export const wrapAnthropic = <T>(c: T): T => c;
