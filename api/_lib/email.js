// Email wording for the portal, English and Arabic (right-to-left). Pure functions, no network:
// render(template, payload, lang, { site, now }) -> { subject, html, text }.
//
// Parent emails are deliberately short: they say there is news and link to the portal. They never
// include what a parent wrote or what staff replied. (The only free text is the reason for a change
// of priority, which the parent also sees in the portal, as the plan asks.)
const L = require("../../js/portal-logic.js");

const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const URG = {
  en: { critical: "Critical", urgent: "Urgent", can_wait: "Can wait" },
  ar: { critical: "حرج", urgent: "عاجل", can_wait: "يمكن الانتظار" },
};
const STEP = {
  en: { parent_called: "We called you", facts_gathered: "Facts gathered", findings: "Findings written", actions_taken: "Actions taken", parent_informed: "You were informed", closed: "Review closed", opened: "Review opened" },
  ar: { parent_called: "اتصلنا بك", facts_gathered: "جمع المعلومات", findings: "كتابة النتائج", actions_taken: "الإجراءات المتخذة", parent_informed: "تم إبلاغك", closed: "انتهت المراجعة", opened: "بدأت المراجعة" },
};
const KIND = { en: { ack: "acknowledging it", resolve: "resolving it" }, ar: { ack: "تأكيد الاطلاع عليه", resolve: "حله" } };

const ref = (p) => (p.ref_no ? L.refLabel(p.ref_no) : "");

// Each template returns { subject, lines: [..], button: [text, path] } for the given language.
const T = {
  received: (p, l, c) => l === "ar"
    ? { subject: `استلمنا رسالتك (${ref(p)})`, lines: [`شكراً لإخبارنا. الرقم المرجعي لطلبك: ${ref(p)}.`,
        p.urgency === "critical" ? `سيتصل بك المدير خلال ساعة واحدة، قبل ${c.when(p.acknowledge_by)}.` : `سنعود إليك قبل ${c.when(p.acknowledge_by)}.`], button: ["عرض الطلب", `/portal/#/case/${p.id}`] }
    : { subject: `We received your message (${ref(p)})`, lines: [`Thank you for telling us. Your reference number is ${ref(p)}.`,
        p.urgency === "critical" ? `A manager will call you within 1 hour, by ${c.when(p.acknowledge_by)}.` : `We will get back to you by ${c.when(p.acknowledge_by)}.`], button: ["View your case", `/portal/#/case/${p.id}`] },
  acknowledged: (p, l) => l === "ar"
    ? { subject: `اطلعنا على طلبك (${ref(p)})`, lines: ["اطلع أحد أفراد الحضانة على طلبك ويتابعه الآن. افتح البوابة للتفاصيل."], button: ["عرض الطلب", `/portal/#/case/${p.id}`] }
    : { subject: `We have seen your message (${ref(p)})`, lines: ["Someone at the academy has seen your message and is looking into it. Open the portal for details."], button: ["View your case", `/portal/#/case/${p.id}`] },
  update_added: (p, l) => l === "ar"
    ? { subject: `تحديث جديد على طلبك (${ref(p)})`, lines: ["يوجد تحديث جديد على طلبك. افتح البوابة لقراءته."], button: ["قراءة التحديث", `/portal/#/case/${p.id}`] }
    : { subject: `There is an update on your case (${ref(p)})`, lines: ["There is a new update on your case. Open the portal to read it."], button: ["Read the update", `/portal/#/case/${p.id}`] },
  urgency_changed: (p, l) => l === "ar"
    ? { subject: `غيّرنا أولوية طلبك (${ref(p)})`, lines: [`تغيّرت الأولوية من «${URG.ar[p.old_urgency] || ""}» إلى «${URG.ar[p.urgency] || ""}».`, p.reason ? `السبب: ${p.reason}` : ""], button: ["عرض الطلب", `/portal/#/case/${p.id}`] }
    : { subject: `We changed the priority of your case (${ref(p)})`, lines: [`The priority changed from "${URG.en[p.old_urgency] || ""}" to "${URG.en[p.urgency] || ""}".`, p.reason ? `Reason: ${p.reason}` : ""], button: ["View your case", `/portal/#/case/${p.id}`] },
  resolved: (p, l) => l === "ar"
    ? { subject: `تم حل طلبك (${ref(p)})`, lines: ["تم تحديد طلبك كمُنجز. يُرجى إخبارنا في البوابة إن كنت راضياً عن النتيجة."], button: ["عرض الطلب", `/portal/#/case/${p.id}`] }
    : { subject: `Your case has been marked as resolved (${ref(p)})`, lines: ["Your case has been marked as resolved. Please tell us in the portal whether you are satisfied."], button: ["View your case", `/portal/#/case/${p.id}`] },
  investigation_step: (p, l) => l === "ar"
    ? { subject: "تحديث على مراجعة السلامة", lines: [`خطوة جديدة في مراجعة السلامة: ${(STEP.ar[p.step] || "")}.`], button: p.id ? ["عرض الطلب", `/portal/#/case/${p.id}`] : ["فتح البوابة", "/portal/#/reports"] }
    : { subject: "An update on the safety review", lines: [`A new step in the safety review was completed: ${(STEP.en[p.step] || "")}.`], button: p.id ? ["View your case", `/portal/#/case/${p.id}`] : ["Open the portal", "/portal/#/reports"] },
  accident_report: (p, l) => l === "ar"
    ? { subject: "يوجد تقرير حادث جديد", lines: ["ينتظرك تقرير عن حادث يخص طفلك في البوابة. يُرجى الاطلاع عليه."], button: ["قراءة التقرير", "/portal/#/reports"] }
    : { subject: "A new accident report is available", lines: ["An accident report about your child is waiting in the portal. Please read it."], button: ["Read the report", "/portal/#/reports"] },

  // ---- staff
  assigned: (p, l, c) => l === "ar"
    ? { subject: `أُسند إليك طلب (${ref(p)})`, lines: [`${p.title}`, `الأولوية: ${URG.ar[p.urgency] || ""}`, p.acknowledge_by ? `موعد الرد: ${c.when(p.acknowledge_by)}` : ""], button: ["فتح الطلب", `/staff/#/case/${p.id}`] }
    : { subject: `A case was assigned to you (${ref(p)})`, lines: [`${p.title}`, `Urgency: ${URG.en[p.urgency] || ""}`, p.acknowledge_by ? `Respond by: ${c.when(p.acknowledge_by)}` : ""], button: ["Open the case", `/staff/#/case/${p.id}`] },
  critical_alert: (p, l) => l === "ar"
    ? { subject: `تنبيه حرج (${ref(p)})`, lines: [`${p.title}`, "هذا الطلب حرج ويحتاج إلى اتصال بوليّ الأمر خلال ساعة واحدة."], button: ["فتح الطلب", `/staff/#/case/${p.id}`] }
    : { subject: `CRITICAL case (${ref(p)})`, lines: [`${p.title}`, "This case is critical and needs a call to the parent within 1 hour."], button: ["Open the case", `/staff/#/case/${p.id}`] },
  deadline_warning: (p, l, c) => l === "ar"
    ? { subject: `موعد يقترب خلال أقل من ساعة (${ref(p)})`, lines: [`${p.title}`, `الموعد المحدد لـ${(KIND.ar[p.kind] || "")}: ${c.when(p.deadline)}.`], button: ["فتح الطلب", `/staff/#/case/${p.id}`] }
    : { subject: `Deadline in under 1 hour (${ref(p)})`, lines: [`${p.title}`, `The deadline for ${(KIND.en[p.kind] || "")} is ${c.when(p.deadline)}.`], button: ["Open the case", `/staff/#/case/${p.id}`] },
  escalated: (p, l) => l === "ar"
    ? { subject: `تم تصعيد طلب إليك (المستوى ${p.level}) (${ref(p)})`, lines: [`${p.title}`, "فات موعد الرد على هذا الطلب فتم تصعيده إليك تلقائياً."], button: ["فتح الطلب", `/staff/#/case/${p.id}`] }
    : { subject: `Escalated to you, level ${p.level} (${ref(p)})`, lines: [`${p.title}`, "The deadline on this case was missed, so it was escalated to you automatically."], button: ["Open the case", `/staff/#/case/${p.id}`] },
  overdue_top: (p, l) => l === "ar"
    ? { subject: `طلب متأخر في أعلى مستوى (${ref(p)})`, lines: [`${p.title}`, "فات موعد هذا الطلب وهو الآن في أعلى مستوى تصعيد."], button: ["فتح الطلب", `/staff/#/case/${p.id}`] }
    : { subject: `Overdue at the highest level (${ref(p)})`, lines: [`${p.title}`, "The deadline on this case was missed and it is already at the highest escalation level."], button: ["Open the case", `/staff/#/case/${p.id}`] },
  serious_accident: (p, l) => l === "ar"
    ? { subject: "تم تسجيل حادث خطير", lines: ["سُجّل حادث خطير وفُتحت مراجعة سلامة."], button: ["فتح المراجعات", "/staff/#/investigations"] }
    : { subject: "A serious accident was logged", lines: ["A serious accident was logged and a safety investigation was opened."], button: ["Open investigations", "/staff/#/investigations"] },
};

function render(template, payload, lang, opts) {
  opts = opts || {};
  const l = lang === "ar" ? "ar" : "en";
  const make = T[template];
  if (!make) throw new Error("Unknown email template: " + template);
  const site = (opts.site || "").replace(/\/+$/, "");
  const now = opts.now == null ? Date.now() : opts.now;
  const ctx = { when: (iso) => L.whenText(iso, now, l) };
  const p = payload || {};
  const r = make(p, l, ctx);
  const lines = r.lines.filter(Boolean);
  const url = site + r.button[1];
  const rtl = l === "ar";
  const brand = rtl ? "كيوت كيدز أكاديمي" : "Cute Kids Academy";
  const footer = rtl ? "هذه رسالة تلقائية من بوابة الحضانة. لا ترد عليها." : "This is an automatic message from the academy portal. Please do not reply to it.";
  const html = `<!doctype html><html lang="${l}" dir="${rtl ? "rtl" : "ltr"}"><body style="margin:0;background:#FFFBF5;font-family:Arial,Tahoma,sans-serif;color:#2B2340">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:16px;border-top:6px solid #E6197F">
<tr><td style="padding:24px 24px 8px;font-size:20px;font-weight:700;color:#E6197F">${esc(brand)}</td></tr>
<tr><td style="padding:8px 24px;font-size:16px;line-height:1.6"><p style="margin:0 0 12px;font-size:18px;font-weight:700">${esc(r.subject)}</p>${lines.map((x) => `<p style="margin:0 0 10px">${esc(x)}</p>`).join("")}</td></tr>
<tr><td style="padding:12px 24px 24px"><a href="${esc(url)}" style="display:inline-block;background:#E6197F;color:#ffffff;text-decoration:none;font-weight:700;padding:12px 26px;border-radius:999px">${esc(r.button[0])}</a></td></tr>
<tr><td style="padding:0 24px 20px;font-size:12px;color:#6b647c">${esc(footer)}</td></tr>
</table></td></tr></table></body></html>`;
  const text = [r.subject, "", ...lines, "", `${r.button[0]}: ${url}`, "", footer].join("\n");
  return { subject: r.subject, html, text };
}

module.exports = { render, TEMPLATES: Object.keys(T) };
