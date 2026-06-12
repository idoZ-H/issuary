// Admins page — list, add, remove. Self-protection: you cannot remove
// yourself (the button is disabled).

import type { Env } from "../../types";
import { listAdmins, putAdmin, deleteAdmin } from "../../lib/kv";
import { html, htmlResponse } from "../html";
import { renderPage, type NavKey } from "../layout";
import { redirect, type CurrentAdmin } from "../auth";

const NAV: NavKey = "admins";

export async function renderAdminsList(
  env: Env,
  currentAdmin: CurrentAdmin,
  flash?: { kind: "error" | "ok"; message: string },
): Promise<Response> {
  const admins = await listAdmins(env);
  const body = html`
    <h2 class="title">Admins</h2>
    <p class="subtitle">${admins.length} ${admins.length === 1 ? "admin" : "admins"} can run /admin commands and access this dashboard.</p>
    ${admins.length === 0
      ? html`<div class="empty">no admins configured (you shouldn't see this if you're logged in)</div>`
      : html`
        <table>
          <thead>
            <tr><th>tg_user_id</th><th>role</th><th></th></tr>
          </thead>
          <tbody>
            ${admins.map((tgUserId) => {
              const isSelf = tgUserId === currentAdmin.tg_user_id;
              return html`
                <tr>
                  <td>${tgUserId}${isSelf ? html` <span class="badge badge-ok">you</span>` : html``}</td>
                  <td>admin</td>
                  <td>
                    ${isSelf
                      ? html`<button class="btn btn-danger btn-sm" disabled title="can't remove yourself">remove</button>`
                      : html`
                          <form method="post" action="/admin/admins/${tgUserId}/delete" onsubmit="return confirm('Remove admin ${tgUserId}?')" style="display:inline;">
                            <button class="btn btn-danger btn-sm" type="submit">remove</button>
                          </form>
                        `}
                  </td>
                </tr>
              `;
            })}
          </tbody>
        </table>
      `
    }
    <h3 class="title" style="font-size:13px; margin-top:24px;">Add admin</h3>
    <p class="subtitle">The tg_user_id must already be a real Telegram account — there's no verification step beyond that.</p>
    <form method="post" action="/admin/admins" class="form-row">
      <div class="field">
        <label for="new_tg_user_id">telegram user id</label>
        <input class="input" id="new_tg_user_id" name="tg_user_id" type="number" required autocomplete="off">
      </div>
      <button class="btn" type="submit">add admin</button>
    </form>
  `;
  return htmlResponse(renderPage({ title: "Admins", nav: NAV, currentAdmin, body, flash }));
}

export async function handleAddAdmin(
  env: Env, req: Request,
): Promise<Response> {
  const form = await req.formData();
  const tgUserId = Number(String(form.get("tg_user_id") ?? "").trim());
  if (!Number.isFinite(tgUserId) || tgUserId <= 0) {
    return redirect("/admin/admins");
  }
  await putAdmin(env, tgUserId);
  return redirect("/admin/admins");
}

export async function handleRemoveAdmin(
  env: Env, tgUserId: number, currentAdmin: CurrentAdmin,
): Promise<Response> {
  if (tgUserId === currentAdmin.tg_user_id) {
    return redirect("/admin/admins");
  }
  await deleteAdmin(env, tgUserId);
  return redirect("/admin/admins");
}
