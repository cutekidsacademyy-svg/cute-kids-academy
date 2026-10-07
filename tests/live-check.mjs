// Looks at the LIVE Supabase project from the outside, exactly as an anonymous visitor on the internet
// would (using only the public "anon" key that is already in js/portal-config.js). READ-ONLY: it asks
// questions and never creates, changes or deletes anything.
//
// Run:  node tests/live-check.mjs
// It is not part of the normal test run because it needs the internet.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = join(fileURLToPath(import.meta.url), "..", "..");
const cfg = readFileSync(join(root, "js", "portal-config.js"), "utf8");
const URL_ = /supabaseUrl:\s*"([^"]+)"/.exec(cfg)?.[1];
const KEY = /supabaseAnonKey:\s*"([^"]+)"/.exec(cfg)?.[1];
if (!URL_ || !KEY) { console.log("The portal is not configured (js/portal-config.js is empty)."); process.exit(0); }

const H = { apikey: KEY, Authorization: "Bearer " + KEY };
const TABLES = ["profiles", "classes", "children", "parent_children", "staff_classes", "submissions", "submission_events", "incidents", "investigations",
  "investigation_internal", "investigation_steps", "ratings", "attachments", "email_outbox", "deadline_events", "staff_attendance", "hr_log", "staff_complaints",
  "mistake_categories", "mistakes", "investigation_faults", "owner_settings", "checklist_items", "checklist_checks", "owner_tasks"];

let bad = 0;
const line = (ok, label, detail = "") => { if (!ok) bad++; console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  " + detail : ""}`); };

console.log("Project:", URL_, "\n");

// 1. Is public sign-up switched off?
const settings = await (await fetch(`${URL_}/auth/v1/settings`, { headers: H })).json();
line(settings.disable_signup === true, "public sign-up is switched OFF (accounts exist only by invitation)", `disable_signup=${settings.disable_signup}`);
line(!settings.external || !Object.entries(settings.external).some(([k, v]) => v && k !== "email" && k !== "phone"), "no social-login providers are enabled", JSON.stringify(Object.entries(settings.external || {}).filter(([, v]) => v).map(([k]) => k)));

// 2. Can an anonymous visitor read any table?
console.log("");
let exposed = 0, blocked = 0, missing = 0;
for (const t of TABLES) {
  const res = await fetch(`${URL_}/rest/v1/${t}?select=*&limit=1`, { headers: H });
  const body = await res.text();
  if (res.status === 404 || /PGRST205|does not exist/.test(body)) { missing++; console.log(`  --    ${t}: not created yet in this project`); continue; }
  let rows = null; try { rows = JSON.parse(body); } catch (e) {}
  if (res.ok && Array.isArray(rows) && rows.length > 0) { exposed++; line(false, `${t}: an anonymous visitor can READ rows`, JSON.stringify(rows[0]).slice(0, 80)); }
  else { blocked++; }
}
line(exposed === 0, `anonymous visitors cannot read any table (${blocked} blocked${missing ? `, ${missing} not created yet` : ""})`);

// 3. Can an anonymous visitor write? (a harmless, invalid write: it must be refused before anything happens)
const w = await fetch(`${URL_}/rest/v1/profiles`, { method: "POST", headers: { ...H, "Content-Type": "application/json", Prefer: "return=minimal" }, body: JSON.stringify({}) });
line(w.status === 401 || w.status === 403, "anonymous visitors cannot write to the profiles table", `HTTP ${w.status}`);

// 4. Which functions can an anonymous visitor even see? (PostgREST lists only what the key may call.)
const spec = await (await fetch(`${URL_}/rest/v1/`, { headers: H })).json();
const rpcs = Object.keys(spec.paths || {}).filter((p) => p.startsWith("/rpc/")).map((p) => p.slice(5));
const dangerous = ["cka_enqueue_email", "cka_run_deadline_check", "cka_run_owner_reminders", "cka_run_attendance_check", "cka_run_birthdays", "cka_run_transport_billing", "birthday_wall", "cka_birthday_send", "cka_run_billing", "cka_balances", "cka_pay_log", "cka_pay_notify_parents", "cka_run_absence_check", "cka_absence_streak", "cka_is_school_day", "cka_media_expired", "cka_media_apply", "cka_media_names", "cka_run_content_check", "cka_announcement_parents", "cka_event_children", "cka_run_report_check", "cka_report_upsert", "cka_report_send_one", "cka_att_log", "cka_door_allowed", "cka_person_name", "cka_level_assignee", "cka_alert_recipients"];
const exposedDangerous = rpcs.filter((r) => dangerous.includes(r));
line(exposedDangerous.length === 0, "internal functions (email queue, deadline checker, name lookup) are NOT callable by anonymous visitors", exposedDangerous.join(", "));
const tablesListed = Object.keys(spec.paths || {}).filter((p) => !p.startsWith("/rpc/") && p !== "/");
console.log(`  info  anonymous visitors can see ${tablesListed.length} table endpoint(s) and ${rpcs.length} function(s) in the API: ${rpcs.join(", ") || "none"}`);

// 4b. Can an anonymous visitor RUN internal functions? Harmless read-only probes: with a random id these answer
//     "null" if the visitor is allowed to run them, and "permission denied" if not.
for (const [fn, args] of [["auth_role", {}], ["cka_actor_name", {}], ["cka_person_name", { p_id: "00000000-0000-4000-8000-00000000abcd" }]]) {
  const r = await fetch(`${URL_}/rest/v1/rpc/${fn}`, { method: "POST", headers: { ...H, "Content-Type": "application/json" }, body: JSON.stringify(args) });
  line(r.status !== 200, `anonymous visitors cannot run the internal function ${fn}()`, `HTTP ${r.status}`);
}

// 5. Storage: the photo bucket must not serve files publicly
const pub = await fetch(`${URL_}/storage/v1/object/public/attachments/anything.jpg`, { headers: H });
line(pub.status === 400 || pub.status === 404, "the photo bucket does not serve public links", `HTTP ${pub.status}`);
const list = await fetch(`${URL_}/storage/v1/bucket`, { headers: H });
line([400, 401, 403].includes(list.status) || ((await list.clone().json().catch(() => [])) || []).length === 0, "anonymous visitors cannot list storage buckets", `HTTP ${list.status}`);

console.log(`\n${bad ? bad + " CHECK(S) FAILED" : "All live checks passed"}.`);
process.exit(bad ? 1 : 0);
