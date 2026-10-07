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
  // ---- owner routine reminders
  checklist_morning: (p, l) => l === "ar"
    ? { subject: `جولة الصباح: أُنجز ${p.done} من ${p.total} بنود`, lines: ["لم تكتمل قائمة جولة الصباح اليوم بعد. يُرجى إكمالها."], button: ["فتح القائمة", "/staff/#/routine"] }
    : { subject: `Morning walk: ${p.done} of ${p.total} checks done`, lines: ["Today's morning-walk checklist is not finished yet. Please complete it."], button: ["Open the checklist", "/staff/#/routine"] },
  checklist_afternoon: (p, l) => l === "ar"
    ? { subject: `فحص بعد الظهر: أُنجز ${p.done} من ${p.total} بنود`, lines: ["لم تكتمل قائمة فحص بعد الظهر اليوم بعد. يُرجى إكمالها."], button: ["فتح القائمة", "/staff/#/routine"] }
    : { subject: `Afternoon check: ${p.done} of ${p.total} checks done`, lines: ["Today's afternoon checklist is not finished yet. Please complete it."], button: ["Open the checklist", "/staff/#/routine"] },
  review_thursday: (p, l) => l === "ar"
    ? { subject: "مراجعة الخميس اليوم", lines: ["حان وقت مراجعة الخميس الأسبوعية.", `المهام المتأخرة: ${p.late_tasks}.`], button: ["فتح المهام", "/staff/#/routine"] }
    : { subject: "Thursday review today", lines: ["It is time for the weekly Thursday review.", `Late tasks: ${p.late_tasks}.`], button: ["Open the tasks", "/staff/#/routine"] },
  review_monthly: (p, l) => l === "ar"
    ? { subject: "مراجعة الشهر", lines: ["بدأ شهر جديد وحان وقت المراجعة الشهرية.", `المهام المتأخرة: ${p.late_tasks}.`], button: ["فتح لوحة المالك", "/staff/#/owner"] }
    : { subject: "Monthly review", lines: ["A new month has started: time for the monthly review.", `Late tasks: ${p.late_tasks}.`], button: ["Open the owner dashboard", "/staff/#/owner"] },
  // ---- absence follow-up and messages from the academy (parents get only "there is a message"; the text is in the portal)
  academy_message: (p, l) => l === "ar"
    ? { subject: "رسالة من الحضانة", lines: ["لديك رسالة من الحضانة. يُرجى قراءتها في البوابة."], button: ["قراءة الرسالة", "/portal/#/messages"] }
    : { subject: "A message from the academy", lines: ["You have a message from the academy. Please read it in the portal."], button: ["Read the message", "/portal/#/messages"] },
  absence_task: (p, l) => l === "ar"
    ? { subject: `${p.count} طفل غائب ٣ أيام أو أكثر`, lines: ["هناك أطفال غابوا ٣ أيام عمل متتالية أو أكثر. يجب إرسال رسالة اطمئنان إلى أسرهم قبل الساعة ٦ مساءً اليوم."], button: ["فتح متابعة الغياب", "/staff/#/absences"] }
    : { subject: `${p.count} child${Number(p.count) === 1 ? "" : "ren"} absent 3 or more days: check-in needed today`, lines: ["Some children have been absent 3 or more school days in a row. A check-in message to their families must be sent before 6 pm today."], button: ["Open absence follow-up", "/staff/#/absences"] },
  absence_escalated: (p, l) => l === "ar"
    ? { subject: "متابعة غياب لم تُرسل قبل السادسة مساءً", lines: ["لم تُرسل رسالة اطمئنان إلى أسرة طفل غائب ٣ أيام أو أكثر قبل الساعة ٦ مساءً."], button: ["فتح متابعة الغياب", "/staff/#/absences"] }
    : { subject: "An absence check-in was not sent by 6 pm", lines: ["A check-in message to the family of a child absent 3 or more days was not sent by 6 pm."], button: ["Open absence follow-up", "/staff/#/absences"] },
  followup_leaving: (p, l) => l === "ar"
    ? { subject: "أسرة تفكر في المغادرة", lines: ["سجّلت الإدارة أن إحدى الأسر تفكر في ترك الحضانة بعد غياب طفلها. يُرجى المتابعة اليوم."], button: ["فتح متابعة الغياب", "/staff/#/absences"] }
    : { subject: "A family is considering leaving", lines: ["Admin recorded that a family is considering leaving after their child's absence. Please follow up today."], button: ["Open absence follow-up", "/staff/#/absences"] },
  // ---- a new question or missing item (to the academy's inbox and the admins: the text is included, this is internal)
  question_new: (p, l) => {
    const what = p.type === "missing_item" ? (l === "ar" ? "غرض مفقود" : "Missing item") : (l === "ar" ? "سؤال جديد" : "New question");
    const topic = p.topic && p.type === "question" ? ({ fees: ["Fees", "الرسوم"], schedule: ["Schedule", "الجدول"], food: ["Food", "الطعام"], my_childs_day: ["My child's day", "يوم طفلي"], other: ["Other", "أخرى"] }[p.topic] || [""])[l === "ar" ? 1 : 0] : "";
    const ref = p.ref_no ? L.refLabel(p.ref_no) : "";
    return l === "ar"
      ? { subject: `${what} (${ref})${topic ? ": " + topic : ""}`, lines: [`من: ${p.parent_name || ""} · الطفل: ${p.child_name || ""}`, `الأولوية: ${URG.ar[p.urgency] || ""}`, p.text || ""], button: ["فتح الطلب", `/staff/#/case/${p.id}`] }
      : { subject: `${what} (${ref})${topic ? ": " + topic : ""}`, lines: [`From: ${p.parent_name || ""} · Child: ${p.child_name || ""}`, `Urgency: ${URG.en[p.urgency] || ""}`, p.text || ""], button: ["Open the case", `/staff/#/case/${p.id}`] };
  },
  // ---- announcements and events (no details: the text itself is only in the portal)
  announcement_new: (p, l) => l === "ar"
    ? { subject: p.important ? "إعلان مهم من الحضانة" : "إعلان جديد من الحضانة", lines: ["يوجد إعلان جديد ينتظرك في البوابة."], button: ["قراءة الإعلان", "/portal/#/news"] }
    : { subject: p.important ? "An important announcement from the academy" : "A new announcement from the academy", lines: ["There is a new announcement waiting for you in the portal."], button: ["Read it", "/portal/#/news"] },
  announcement_reminder: (p, l) => l === "ar"
    ? { subject: "تذكير: إعلان مهم لم تقرأه بعد", lines: ["لديك إعلان مهم لم تطّلع عليه بعد. يُرجى قراءته في البوابة."], button: ["قراءة الإعلان", "/portal/#/news"] }
    : { subject: "Reminder: an important announcement you have not read", lines: ["You have an important announcement that you have not opened yet. Please read it in the portal."], button: ["Read it", "/portal/#/news"] },
  event_new: (p, l) => l === "ar"
    ? { subject: p.needs_approval ? "فعالية جديدة تحتاج إلى موافقتك" : "فعالية جديدة في التقويم", lines: [p.needs_approval ? "هناك فعالية جديدة تحتاج إلى موافقتك قبل موعد محدد. يُرجى الرد في البوابة." : "تمت إضافة فعالية أو إغلاق إلى التقويم."], button: ["فتح التقويم", "/portal/#/calendar"] }
    : { subject: p.needs_approval ? "A new event needs your answer" : "A new item in the calendar", lines: [p.needs_approval ? "There is a new event that needs your answer before a deadline. Please reply in the portal." : "An event or closure was added to the calendar."], button: ["Open the calendar", "/portal/#/calendar"] },
  event_reminder: (p, l) => l === "ar"
    ? { subject: "تذكير: فعالية تنتظر ردّك", lines: ["ينتهي قريباً موعد الرد على فعالية. يُرجى الرد في البوابة."], button: ["فتح التقويم", "/portal/#/calendar"] }
    : { subject: "Reminder: an event is waiting for your answer", lines: ["The deadline to answer an event is close. Please reply in the portal."], button: ["Open the calendar", "/portal/#/calendar"] },
  // ---- daily reports (no details: just that something is ready)
  daily_report_ready: (p, l) => l === "ar"
    ? { subject: "تقرير طفلك اليومي جاهز", lines: ["تقرير اليوم عن طفلك ينتظرك في البوابة."], button: ["قراءة التقرير", "/portal/#/daily"] }
    : { subject: "Your child's daily report is ready", lines: ["Today's report about your child is waiting in the portal."], button: ["Read the report", "/portal/#/daily"] },
  fever_alert: (p, l) => l === "ar"
    ? { subject: "تنبيه: ارتفاع حرارة طفل", lines: ["سُجّلت درجة حرارة 38 أو أكثر لأحد أطفال فصلك. يُرجى مراجعة تقارير اليوم والتواصل مع وليّ الأمر."], button: ["فتح التقارير اليومية", "/staff/#/daily"] }
    : { subject: "Alert: a child has a high temperature", lines: ["A temperature of 38 or more was recorded for a child in your class. Please check today's reports and contact the parent."], button: ["Open the daily reports", "/staff/#/daily"] },
  report_note_reminder: (p, l) => l === "ar"
    ? { subject: `${p.count} أطفال بلا جملة شخصية في تقريرهم`, lines: ["حان وقت كتابة جملة شخصية لكل طفل في تقريره اليومي قبل موعد الاستلام."], button: ["فتح التقارير اليومية", "/staff/#/daily"] }
    : { subject: `${p.count} child${Number(p.count) === 1 ? "" : "ren"} still need a personal note`, lines: ["It is time to add one personal sentence to each child's daily report before pickup."], button: ["Open the daily reports", "/staff/#/daily"] },
  // ---- attendance and pickup (no names: just that something needs a look)
  pickup_off_list_parent: (p, l) => l === "ar"
    ? { subject: "تم تسليم طفلك لشخص غير مسجّل في قائمة الاستلام", lines: ["سُجّل اليوم استلام طفلك من شخص غير موجود في قائمة الاستلام الخاصة بك. إذا لم تكن تتوقع ذلك فيُرجى الاتصال بنا فوراً على 01063344389."], button: ["فتح البوابة", "/portal/#/attendance"] }
    : { subject: "Your child was collected by someone not on your pickup list", lines: ["Today your child was collected by someone who is not on your pickup list. If you did not expect this, please call us at once on 01063344389."], button: ["Open the portal", "/portal/#/attendance"] },
  pickup_off_list_staff: (p, l) => l === "ar"
    ? { subject: "استلام طفل من شخص غير مسجّل في القائمة", lines: ["سُجّل استلام طفل من شخص غير موجود في قائمة الاستلام. يُرجى مراجعة سجل الحضور."], button: ["فتح شاشة الباب", "/staff/#/door"] }
    : { subject: "A child was collected by someone not on the pickup list", lines: ["A child was collected by someone who is not on the pickup list. Please check the attendance record."], button: ["Open the door screen", "/staff/#/door"] },
  attendance_missing: (p, l) => l === "ar"
    ? { subject: `${p.count} طفل لم يصل بعد ولم يُبلَّغ عن غيابه`, lines: ["لم يصل بعض الأطفال حتى الساعة 9:30 ولم يُبلَّغ عن غيابهم. يُرجى الاتصال بأولياء أمورهم."], button: ["فتح شاشة الباب", "/staff/#/door"] }
    : { subject: `${p.count} child${Number(p.count) === 1 ? "" : "ren"} not arrived and no absence reported`, lines: ["Some children have not arrived by 9:30 and no absence was reported. Please call their parents."], button: ["Open the door screen", "/staff/#/door"] },
  // ---- registration (the applicant has no login yet, so these point to the website, not the portal)
  registration_received: (p, l) => l === "ar"
    ? { subject: `استلمنا طلب التسجيل رقم ${p.application_no}`, lines: [`شكراً لتقديمك طلب التحاق ${p.child_name} بكيوت كيدز أكاديمي. رقم طلبك: ${p.application_no}.`, "سيراجع فريقنا الطلب ويتواصل معك قريباً. يمكنك الاتصال بنا على 01063344389."], button: ["زيارة الموقع", "/"] }
    : { subject: `We received your application #${p.application_no}`, lines: [`Thank you for applying to Cute Kids Academy for ${p.child_name}. Your application number is ${p.application_no}.`, "Our team will review it and be in touch soon. You can call us on 01063344389."], button: ["Visit our website", "/"] },
  registration_update: (p, l) => {
    const ar = l === "ar", n = p.application_no, kid = p.child_name, note = p.note;
    const by = {
      missing_documents: ar ? ["نحتاج إلى مزيد من المعلومات", [`لإكمال طلب ${kid} نحتاج إلى: ${note}`, "يُرجى التواصل معنا على 01063344389."]]
                            : ["We need a little more information", [`To finish the application for ${kid} we still need: ${note}`, "Please contact us on 01063344389."]],
      tour_booked: ar ? ["تم ترتيب زيارة للحضانة", [`تم ترتيب زيارة للحضانة بخصوص طلب ${kid}.`, "إن لم نتصل بك لتأكيد الموعد فيُرجى الاتصال بنا على 01063344389."]]
                      : ["A tour has been arranged", [`A visit to the academy has been arranged for the application for ${kid}.`, "If you have not heard from us about the time, please call 01063344389."]],
      waitlist: ar ? ["أُضيف طلبك إلى قائمة الانتظار", [`أضفنا طلب ${kid} إلى قائمة الانتظار.`, "سنتواصل معك فور توفر مكان."]]
                   : ["Your application is on our waiting list", [`We have added the application for ${kid} to our waiting list.`, "We will contact you as soon as a place opens."]],
      declined: ar ? ["بخصوص طلب التسجيل", [`نأسف، لا نستطيع عرض مكان لـ${kid} في الوقت الحالي.`, note ? `السبب: ${note}` : "", "نشكرك على اهتمامك."]]
                   : ["About your application", [`We are sorry, we cannot offer a place for ${kid} at the moment.`, note ? `Reason: ${note}` : "", "Thank you for your interest in Cute Kids Academy."]],
      approved: ar ? ["مرحباً بك في كيوت كيدز أكاديمي", [`يسعدنا أن نخبرك بقبول ${kid}!`, "ستصلك رسالة منفصلة برابط لإعداد حسابك في بوابة أولياء الأمور."]]
                   : ["Welcome to Cute Kids Academy", [`We are delighted to tell you that ${kid} has been accepted!`, "You will get a separate email with a link to set up your parent portal login."]],
    };
    const [subject, lines] = by[p.status] || by.approved;
    return { subject: `${subject} (#${n})`, lines, button: [ar ? "زيارة الموقع" : "Visit our website", "/"] };
  },
  child_health_changed: (p, l) => l === "ar"
    ? { subject: "وليّ أمر حدّث معلومات صحية", lines: ["قام وليّ أمر بتحديث المعلومات الصحية لطفل في فصلك. يُرجى مراجعة قائمة الحساسية."], button: ["فتح فصلي", "/staff/#/class"] }
    : { subject: "A parent updated health information", lines: ["A parent updated the health information for a child in your class. Please check the allergy list."], button: ["Open my class", "/staff/#/class"] },
  child_pickup_changed: (p, l) => l === "ar"
    ? { subject: "تغيير في قائمة المخوّلين بالاستلام", lines: ["قام وليّ أمر بتغيير قائمة الأشخاص المخوّلين باستلام طفله. يُرجى مراجعتها قبل الاستلام."], button: ["فتح فصلي", "/staff/#/class"] }
    : { subject: "A pickup list was changed", lines: ["A parent changed the list of people allowed to collect their child. Please check it before the next pickup."], button: ["Open my class", "/staff/#/class"] },
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
