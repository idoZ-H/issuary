import type { ClientRecord } from "../types";

export function buildPickerKeyboard(
  client: ClientRecord,
): Array<Array<{ text: string; callback_data: string }>> {
  const rows = client.projects.map((p) => [{
    text: p.id === client.active_project_id ? `🟢 ${p.name_he}` : p.name_he,
    callback_data: `use:${p.id}`,
  }]);
  rows.push([{ text: "❌ ביטול", callback_data: "use:_cancel" }]);
  return rows;
}
