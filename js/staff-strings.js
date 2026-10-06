// Staff area wording, English and Arabic. Arabic uses the neutral-masculine form common in app
// interfaces; please have a native speaker review it before launch.
(function () {
  var en = {
    "s.nav.queue": "Cases", "s.nav.incident": "Log an accident", "s.nav.accidents": "Accident log", "s.nav.ratings": "Ratings", "s.nav.people": "People",
    "s.back": "← Back", "s.loading": "Loading…", "s.error": "Something went wrong. Please try again.", "s.saved": "Saved.", "s.working": "Working…",
    "s.ov.title": "At a glance", "s.ov.open": "Open at level", "s.ov.overdue": "Overdue now", "s.ov.closed": "Closed this week",
    "s.f.type": "Type", "s.f.urgency": "Urgency", "s.f.status": "Status", "s.f.class": "Class", "s.f.mine": "Assigned to me",
    "s.f.any": "All", "s.f.open": "Open", "s.f.all": "Everything",
    "s.q.empty": "Nothing here. Well done!", "s.q.unassigned": "Unassigned", "s.q.level": "Level", "s.q.parent": "Parent",
    "s.due.overdue": "Overdue since", "s.due.by": "Due", "s.due.done": "Finished",
    "s.st.received": "New", "s.st.acknowledged": "Acknowledged", "s.st.in_progress": "In progress", "s.st.resolved": "Resolved", "s.st.closed": "Closed",
    "s.urg.critical": "Critical", "s.urg.urgent": "Urgent", "s.urg.can_wait": "Can wait",
    "s.type.complaint": "Concern", "s.type.safety_concern": "Safety concern",

    "s.c.details": "Details", "s.c.child": "Child", "s.c.class": "Class", "s.c.parent": "Parent", "s.c.call": "Call", "s.c.about": "About staff member",
    "s.c.created": "Received", "s.c.desc": "What the parent wrote", "s.c.photos": "Photos", "s.c.handler": "Handled by", "s.c.satisfied": "Parent satisfied",
    "s.c.yes": "Yes", "s.c.no": "No", "s.c.actions": "Actions", "s.c.finished": "This case is finished.", "s.c.investigation": "A safety investigation is open for this case.",
    "s.c.ack": "Acknowledge", "s.c.ack.msg": "Message to the parent (optional)", "s.c.ack.btn": "Acknowledge and tell the parent",
    "s.c.start": "Mark in progress", "s.c.assign": "Assign to", "s.c.assign.pick": "Choose a person", "s.c.assign.btn": "Assign",
    "s.c.urgency": "Change urgency", "s.c.reason": "Reason (the parent will see this)", "s.c.urgency.btn": "Change urgency",
    "s.c.update": "Update for the parent", "s.c.update.btn": "Send update to the parent",
    "s.c.note": "Internal note", "s.c.note.hint": "Staff only. Never shown to parents.", "s.c.note.btn": "Save internal note",
    "s.c.escalate": "Escalate", "s.c.escalate.to": "Escalate to level", "s.c.escalate.reason": "Reason", "s.c.escalate.btn": "Escalate",
    "s.c.resolve": "Resolve", "s.c.resolve.msg": "Message to the parent", "s.c.resolve.btn": "Mark as resolved",
    "s.c.timeline": "Timeline", "s.c.internal": "Internal", "s.c.parentsees": "Parent can see", "s.c.system": "System",
    "s.c.needreason": "Please give a reason.", "s.c.needmsg": "Please write a message.", "s.c.needperson": "Please choose a person.",

    "s.ev.created": "Case received", "s.ev.acknowledged": "Acknowledged", "s.ev.status_changed": "Status changed to", "s.ev.urgency_changed": "Urgency changed",
    "s.ev.assigned": "Assigned", "s.ev.escalated": "Escalated", "s.ev.update": "Update sent to parent", "s.ev.internal_note": "Internal note",
    "s.ev.parent_reply": "Parent wrote", "s.ev.resolved": "Resolved", "s.ev.reopened": "Reopened", "s.ev.satisfaction": "Parent is satisfied", "s.ev.investigation_step": "Investigation step",

    "s.i.title": "Log an accident", "s.i.intro": "Record what happened. The parent will see this report in their portal straight away.",
    "s.i.child": "Child", "s.i.when": "When did it happen?", "s.i.where": "Where?", "s.i.what": "What happened?", "s.i.injury": "Injury (if any)",
    "s.i.firstaid": "First aid given", "s.i.severity": "How serious was it?", "s.i.witnesses": "Staff who saw it (names, separated by commas)",
    "s.i.minor": "Minor (a scrape or bump)", "s.i.needs_attention": "Needs attention", "s.i.serious": "Serious",
    "s.i.called": "I have called the parent", "s.i.calledat": "Parent called at",
    "s.i.callreq": "For anything beyond a minor scrape, call the parent first and tick this box.",
    "s.i.seriousnote": "A serious accident also opens a safety investigation for the manager.",
    "s.i.save": "Save accident report", "s.i.saved": "Accident logged. The parent can see it in their portal.",
    "s.i.needchild": "Please choose the child.", "s.i.needwhere": "Please say where it happened.", "s.i.needwhat": "Please describe what happened.",
    "s.i.needcall": "For anything beyond minor, please call the parent and record the time.", "s.i.future": "The time cannot be in the future.",
    "s.a.title": "Accident log", "s.a.none": "No accidents have been logged.", "s.a.read": "Parent has read it", "s.a.unread": "Parent has not read it yet",

    "s.r.title": "Ratings and compliments", "s.r.none": "No ratings yet.", "s.r.care": "Care", "s.r.comm": "Communication", "s.r.daily": "Daily reports",
    "s.r.compliment": "Compliment for", "s.r.privacy": "Only the manager and owner can see ratings.",
  };

  var ar = {
    "s.nav.queue": "الطلبات", "s.nav.incident": "تسجيل حادث", "s.nav.accidents": "سجل الحوادث", "s.nav.ratings": "التقييمات", "s.nav.people": "الأشخاص",
    "s.back": "→ رجوع", "s.loading": "جارٍ التحميل…", "s.error": "حدث خطأ ما. يُرجى المحاولة مرة أخرى.", "s.saved": "تم الحفظ.", "s.working": "جارٍ التنفيذ…",
    "s.ov.title": "نظرة سريعة", "s.ov.open": "مفتوح في المستوى", "s.ov.overdue": "متأخر الآن", "s.ov.closed": "أُغلق هذا الأسبوع",
    "s.f.type": "النوع", "s.f.urgency": "الاستعجال", "s.f.status": "الحالة", "s.f.class": "الفصل", "s.f.mine": "المسندة إليّ",
    "s.f.any": "الكل", "s.f.open": "مفتوح", "s.f.all": "كل شيء",
    "s.q.empty": "لا يوجد شيء هنا. أحسنت!", "s.q.unassigned": "غير مسند", "s.q.level": "المستوى", "s.q.parent": "وليّ الأمر",
    "s.due.overdue": "متأخر منذ", "s.due.by": "الموعد", "s.due.done": "منتهٍ",
    "s.st.received": "جديد", "s.st.acknowledged": "تم الاطلاع", "s.st.in_progress": "قيد المتابعة", "s.st.resolved": "تم الحل", "s.st.closed": "مغلق",
    "s.urg.critical": "حرج", "s.urg.urgent": "عاجل", "s.urg.can_wait": "يمكن الانتظار",
    "s.type.complaint": "ملاحظة", "s.type.safety_concern": "قلق بشأن السلامة",

    "s.c.details": "التفاصيل", "s.c.child": "الطفل", "s.c.class": "الفصل", "s.c.parent": "وليّ الأمر", "s.c.call": "اتصال", "s.c.about": "بخصوص الموظف",
    "s.c.created": "وقت الاستلام", "s.c.desc": "ما كتبه وليّ الأمر", "s.c.photos": "الصور", "s.c.handler": "المسؤول", "s.c.satisfied": "رضا وليّ الأمر",
    "s.c.yes": "نعم", "s.c.no": "لا", "s.c.actions": "الإجراءات", "s.c.finished": "هذا الطلب منتهٍ.", "s.c.investigation": "هناك مراجعة سلامة مفتوحة لهذا الطلب.",
    "s.c.ack": "تأكيد الاطلاع", "s.c.ack.msg": "رسالة إلى وليّ الأمر (اختياري)", "s.c.ack.btn": "تأكيد الاطلاع وإبلاغ وليّ الأمر",
    "s.c.start": "بدء المتابعة", "s.c.assign": "إسناد إلى", "s.c.assign.pick": "اختر شخصاً", "s.c.assign.btn": "إسناد",
    "s.c.urgency": "تغيير الاستعجال", "s.c.reason": "السبب (سيراه وليّ الأمر)", "s.c.urgency.btn": "تغيير الاستعجال",
    "s.c.update": "تحديث لوليّ الأمر", "s.c.update.btn": "إرسال التحديث إلى وليّ الأمر",
    "s.c.note": "ملاحظة داخلية", "s.c.note.hint": "للموظفين فقط. لا تظهر لأولياء الأمور أبداً.", "s.c.note.btn": "حفظ الملاحظة الداخلية",
    "s.c.escalate": "تصعيد", "s.c.escalate.to": "التصعيد إلى المستوى", "s.c.escalate.reason": "السبب", "s.c.escalate.btn": "تصعيد",
    "s.c.resolve": "إنهاء", "s.c.resolve.msg": "رسالة إلى وليّ الأمر", "s.c.resolve.btn": "تحديد كمُنجز",
    "s.c.timeline": "السجل الزمني", "s.c.internal": "داخلي", "s.c.parentsees": "يراه وليّ الأمر", "s.c.system": "النظام",
    "s.c.needreason": "يُرجى كتابة السبب.", "s.c.needmsg": "يُرجى كتابة رسالة.", "s.c.needperson": "يُرجى اختيار شخص.",

    "s.ev.created": "استُلم الطلب", "s.ev.acknowledged": "تم الاطلاع", "s.ev.status_changed": "تغيّرت الحالة إلى", "s.ev.urgency_changed": "تغيّر الاستعجال",
    "s.ev.assigned": "تم الإسناد", "s.ev.escalated": "تم التصعيد", "s.ev.update": "تحديث أُرسل إلى وليّ الأمر", "s.ev.internal_note": "ملاحظة داخلية",
    "s.ev.parent_reply": "كتب وليّ الأمر", "s.ev.resolved": "تم الحل", "s.ev.reopened": "أُعيد فتحه", "s.ev.satisfaction": "وليّ الأمر راضٍ", "s.ev.investigation_step": "خطوة في المراجعة",

    "s.i.title": "تسجيل حادث", "s.i.intro": "سجّل ما حدث. سيظهر هذا التقرير لوليّ الأمر في بوابته فوراً.",
    "s.i.child": "الطفل", "s.i.when": "متى حدث؟", "s.i.where": "أين؟", "s.i.what": "ماذا حدث؟", "s.i.injury": "الإصابة (إن وُجدت)",
    "s.i.firstaid": "الإسعاف الأولي المقدَّم", "s.i.severity": "ما مدى خطورته؟", "s.i.witnesses": "الموظفون الذين شاهدوه (الأسماء مفصولة بفواصل)",
    "s.i.minor": "بسيط (خدش أو ارتطام)", "s.i.needs_attention": "يحتاج إلى متابعة", "s.i.serious": "خطير",
    "s.i.called": "اتصلت بوليّ الأمر", "s.i.calledat": "وقت الاتصال بوليّ الأمر",
    "s.i.callreq": "لأي حادث أكبر من الخدش البسيط، اتصل بوليّ الأمر أولاً ثم ضع علامة هنا.",
    "s.i.seriousnote": "الحادث الخطير يفتح أيضاً مراجعة سلامة لدى المدير.",
    "s.i.save": "حفظ تقرير الحادث", "s.i.saved": "تم تسجيل الحادث. يستطيع وليّ الأمر رؤيته في بوابته.",
    "s.i.needchild": "يُرجى اختيار الطفل.", "s.i.needwhere": "يُرجى ذكر مكان الحادث.", "s.i.needwhat": "يُرجى وصف ما حدث.",
    "s.i.needcall": "لأي حادث أكبر من البسيط، يُرجى الاتصال بوليّ الأمر وتسجيل الوقت.", "s.i.future": "لا يمكن أن يكون الوقت في المستقبل.",
    "s.a.title": "سجل الحوادث", "s.a.none": "لم يُسجَّل أي حادث.", "s.a.read": "اطلع عليه وليّ الأمر", "s.a.unread": "لم يطلع عليه وليّ الأمر بعد",

    "s.r.title": "التقييمات والإشادات", "s.r.none": "لا توجد تقييمات بعد.", "s.r.care": "الرعاية", "s.r.comm": "التواصل", "s.r.daily": "التقارير اليومية",
    "s.r.compliment": "إشادة بـ", "s.r.privacy": "المدير والمالك فقط يستطيعان رؤية التقييمات.",
  };
  Object.assign(CKA.STR.en, en);
  Object.assign(CKA.STR.ar, ar);
})();
