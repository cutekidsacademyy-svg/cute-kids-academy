// Wording for the parent's home dashboard, the "Ask a question" and "missing item" forms, and the More page.
// English and Arabic. Please have a native Arabic speaker review the Arabic before launch.
(function () {
  var en = {
    "p.nav.more": "More", "p.nav.report": "Report",
    "hm.q_ask": "Ask a question", "hm.q_absence": "Report an absence", "hm.q_missing": "Report a missing item", "hm.q_concern": "Raise a concern or complaint",
    "hm.child_status": "Today", "hm.not_arrived": "Not arrived yet", "hm.in_at": "Checked in at", "hm.out_at": "Collected at", "hm.by": "by", "hm.told_absent": "You told us: absent", "hm.told_late": "You told us: coming late",
    "hm.report_ready": "Today's report is ready", "hm.report_open": "Read the report", "hm.report_coming": "Today's report is being prepared. It arrives before pickup.", "hm.report_none": "No report yet today.",
    "hm.month": "This month", "hm.attended": "Days attended", "hm.absent_told": "Days absent (you told us)", "hm.absent_not": "Days absent (not reported)", "hm.late": "Late pickups",
    "hm.schedule": "Today's schedule", "hm.photos": "Latest photos", "hm.all_photos": "See all photos", "hm.coming_up": "Coming up", "hm.all_calendar": "Open the calendar", "hm.nothing_coming": "Nothing coming up.",
    "hm.news": "News", "hm.unread": "unread", "hm.news_none": "You are up to date.", "hm.open_news": "Read the news",
    "hm.waiting": "Waiting for your answer", "hm.answer_by": "answer by", "hm.cases": "Your open cases", "hm.no_cases": "You have no open cases.", "hm.accidents": "Accident reports", "hm.accidents_unread": "waiting to be read",
    "pq.title": "Ask a question", "pq.title_missing": "Report a missing item", "pq.child": "Which child?", "pq.topic": "What is it about?", "pq.t.fees": "Fees", "pq.t.schedule": "Schedule", "pq.t.food": "Food", "pq.t.my_childs_day": "My child's day", "pq.t.other": "Something else",
    "pq.question": "Your question", "pq.item": "What is missing?", "pq.last_seen": "When and where did you last see it?", "pq.desc": "Describe it (colour, size, name written on it)", "pq.photo": "A photo (optional)", "pq.urgent": "It is urgent",
    "pq.urgent_hint": "Tick this only if you need an answer today. Otherwise we answer within one working day.", "pq.send": "Send", "pq.sending": "Sending…", "pq.need_child": "Please choose a child.", "pq.need_text": "Please write your message.", "pq.need_item": "Please say what is missing.", "pq.err": "That could not be sent. Please try again.",
    "pq.sent": "Thank you. We received it.", "pq.ref": "Reference", "pq.promise": "We will answer by", "pq.view": "View the case", "pq.whatsapp": "Ask on WhatsApp", "pq.wa_hint": "Prefer WhatsApp? This opens a chat with the academy with your reference already typed in.",
    "pq.wa_text": "Hello, this is {parent} about {child}. Reference {ref}.", "pq.wa_text_plain": "Hello, this is {parent} about {child}.", "pq.another": "Ask something else", "pq.item_title": "Missing", "pq.photo_bad": "That photo could not be used. Please choose a picture under 5 MB.",
    "mo.title": "More", "mo.attendance": "Attendance and absences", "mo.child": "My child (health, pickup people)", "mo.news": "News", "mo.accidents": "Accident reports", "mo.rate": "Rate your experience", "mo.settings": "Settings and notifications", "mo.concern": "Raise a concern or complaint", "mo.ask": "Ask a question",
  };
  var ar = {
    "p.nav.more": "المزيد", "p.nav.report": "التقرير",
    "hm.q_ask": "اسأل سؤالاً", "hm.q_absence": "أبلغ عن غياب", "hm.q_missing": "أبلغ عن غرض مفقود", "hm.q_concern": "قدّم ملاحظة أو شكوى",
    "hm.child_status": "اليوم", "hm.not_arrived": "لم يصل بعد", "hm.in_at": "حضر في", "hm.out_at": "استُلم في", "hm.by": "بواسطة", "hm.told_absent": "أخبرتنا: غائب", "hm.told_late": "أخبرتنا: سيتأخر",
    "hm.report_ready": "تقرير اليوم جاهز", "hm.report_open": "قراءة التقرير", "hm.report_coming": "يجري إعداد تقرير اليوم. يصلك قبل الاستلام.", "hm.report_none": "لا يوجد تقرير اليوم بعد.",
    "hm.month": "هذا الشهر", "hm.attended": "أيام الحضور", "hm.absent_told": "أيام الغياب (أخبرتنا)", "hm.absent_not": "أيام الغياب (دون إبلاغ)", "hm.late": "استلام متأخر",
    "hm.schedule": "جدول اليوم", "hm.photos": "أحدث الصور", "hm.all_photos": "كل الصور", "hm.coming_up": "قادم", "hm.all_calendar": "فتح التقويم", "hm.nothing_coming": "لا شيء قادم.",
    "hm.news": "الأخبار", "hm.unread": "غير مقروء", "hm.news_none": "اطّلعت على كل شيء.", "hm.open_news": "قراءة الأخبار",
    "hm.waiting": "بانتظار ردّك", "hm.answer_by": "الرد قبل", "hm.cases": "طلباتك المفتوحة", "hm.no_cases": "ليس لديك طلبات مفتوحة.", "hm.accidents": "تقارير الحوادث", "hm.accidents_unread": "بانتظار القراءة",
    "pq.title": "اسأل سؤالاً", "pq.title_missing": "أبلغ عن غرض مفقود", "pq.child": "أيّ طفل؟", "pq.topic": "عمّ يدور؟", "pq.t.fees": "الرسوم", "pq.t.schedule": "الجدول", "pq.t.food": "الطعام", "pq.t.my_childs_day": "يوم طفلي", "pq.t.other": "شيء آخر",
    "pq.question": "سؤالك", "pq.item": "ما الذي فُقد؟", "pq.last_seen": "متى وأين رأيته آخر مرة؟", "pq.desc": "صِفه (اللون والحجم والاسم المكتوب عليه)", "pq.photo": "صورة (اختياري)", "pq.urgent": "الأمر عاجل",
    "pq.urgent_hint": "ضع علامة هنا فقط إذا كنت تحتاج إجابة اليوم. وإلا نجيب خلال يوم عمل.", "pq.send": "إرسال", "pq.sending": "جارٍ الإرسال…", "pq.need_child": "يُرجى اختيار طفل.", "pq.need_text": "يُرجى كتابة رسالتك.", "pq.need_item": "يُرجى ذكر ما فُقد.", "pq.err": "تعذّر الإرسال. يُرجى المحاولة مرة أخرى.",
    "pq.sent": "شكراً لك. استلمنا طلبك.", "pq.ref": "الرقم المرجعي", "pq.promise": "سنجيب قبل", "pq.view": "عرض الطلب", "pq.whatsapp": "اسأل عبر واتساب", "pq.wa_hint": "تفضّل واتساب؟ يفتح هذا محادثة مع الحضانة وقد كُتب فيها رقمك المرجعي.",
    "pq.wa_text": "مرحباً، أنا {parent} بخصوص {child}. الرقم المرجعي {ref}.", "pq.wa_text_plain": "مرحباً، أنا {parent} بخصوص {child}.", "pq.another": "اسأل شيئاً آخر", "pq.item_title": "مفقود", "pq.photo_bad": "تعذّر استخدام هذه الصورة. يُرجى اختيار صورة أقل من 5 ميجابايت.",
    "mo.title": "المزيد", "mo.attendance": "الحضور والغياب", "mo.child": "طفلي (الصحة والمخوّلون بالاستلام)", "mo.news": "الأخبار", "mo.accidents": "تقارير الحوادث", "mo.rate": "قيّم تجربتك", "mo.settings": "الإعدادات والإشعارات", "mo.concern": "قدّم ملاحظة أو شكوى", "mo.ask": "اسأل سؤالاً",
  };
  Object.assign(CKA.STR.en, en);
  Object.assign(CKA.STR.ar, ar);
})();
