import { describe, it, expect } from "vitest";
import { buildPickerKeyboard } from "../../src/lib/picker";
import type { ClientRecord } from "../../src/types";

const c = (active: string) => ({
  name: "X", telegram_chat_id: 1, active: true, created_at: "x",
  projects: [
    { id: "a", name_he: "AAA", repo: "x/a", created_at: "x" },
    { id: "b", name_he: "BBB", repo: "x/b", created_at: "x" },
  ],
  active_project_id: active, default_project_id: "a",
});

describe("buildPickerKeyboard", () => {
  it("marks the active project with a 🟢 prefix", () => {
    const kb = buildPickerKeyboard(c("b") as any);
    expect(kb.flat().find((b) => b.callback_data === "use:b")?.text).toMatch(/🟢/);
    expect(kb.flat().find((b) => b.callback_data === "use:a")?.text).not.toMatch(/🟢/);
  });

  it("uses callback_data shape 'use:<project_id>'", () => {
    const kb = buildPickerKeyboard(c("a") as any);
    expect(kb.flat().every((b) => b.callback_data.startsWith("use:"))).toBe(true);
  });

  it("returns one button per project, one per row", () => {
    const kb = buildPickerKeyboard(c("a") as any);
    // 2 project rows + 1 cancel row
    expect(kb).toHaveLength(3);
    expect(kb.every((row) => row.length === 1)).toBe(true);
  });

  it("appends a cancel row as the last row", () => {
    const client: ClientRecord = {
      name: "X", telegram_chat_id: 1, active: true, created_at: "t",
      projects: [
        { id: "a", name_he: "פרויקט א", repo: "x/a", created_at: "t" },
        { id: "b", name_he: "פרויקט ב", repo: "x/b", created_at: "t" },
      ],
      active_project_id: "a", default_project_id: "a",
    };
    const kb = buildPickerKeyboard(client);
    const lastRow = kb[kb.length - 1]!;
    expect(lastRow).toHaveLength(1);
    expect(lastRow[0]!.callback_data).toBe("use:_cancel");
    expect(lastRow[0]!.text).toMatch(/ביטול/);
  });
});
