// Test stub for the bare `langsmith` package (Client class). The real package
// transitively imports node:fs/promises, which workerd doesn't surface in
// vitest-pool-workers. Production picks langsmith's browser build via
// package.json exports.
export class Client {
  constructor(_opts?: unknown) {}
  awaitPendingTraceBatches(): Promise<void> { return Promise.resolve(); }
}
