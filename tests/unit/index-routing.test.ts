import { describe, it, expect } from "vitest";
import worker from "../../src/index";

describe("Worker routing", () => {
  it("returns 200 with health JSON on GET /", async () => {
    const req = new Request("https://w/", { method: "GET" });
    const res = await worker.fetch(req, {} as any, {} as any);
    expect(res.status).toBe(200);
    const j = await res.json<any>();
    expect(j.ok).toBe(true);
  });

  it("returns 405 on GET /telegram/webhook", async () => {
    const req = new Request("https://w/telegram/webhook", { method: "GET" });
    const res = await worker.fetch(req, {} as any, {} as any);
    expect(res.status).toBe(405);
  });

  it("returns 405 on GET /github/webhook", async () => {
    const req = new Request("https://w/github/webhook", { method: "GET" });
    const res = await worker.fetch(req, {} as any, {} as any);
    expect(res.status).toBe(405);
  });

  it("returns 404 on unknown route", async () => {
    const req = new Request("https://w/nope", { method: "POST" });
    const res = await worker.fetch(req, {} as any, {} as any);
    expect(res.status).toBe(404);
  });
});
