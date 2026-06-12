import type { Env, ClientRecord, ProjectRecord } from "../types";
import { getClient, getActiveProject } from "../lib/kv";

export type IdentityResult =
  | { kind: "ok"; record: ClientRecord; project: ProjectRecord }
  | { kind: "unknown" }
  | { kind: "inactive" };

export async function resolveIdentity(env: Env, tgUserId: number): Promise<IdentityResult> {
  const record = await getClient(env, tgUserId);
  if (!record) return { kind: "unknown" };
  if (!record.active) return { kind: "inactive" };
  return { kind: "ok", record, project: getActiveProject(record) };
}
