// Wording for the investigation screens (manager and owner), English and Arabic.
// Please have a native Arabic speaker review the Arabic before launch.
(function () {
  var en = {
    "s.nav.investigations": "Investigations",
    "s.v.title": "Safety investigations", "s.v.none": "There are no investigations.", "s.v.open": "open", "s.v.closed": "closed",
    "s.v.kind.accident": "Accident", "s.v.kind.safety_concern": "Safety concern", "s.v.took": "Took", "s.v.running": "Open for",
    "s.v.hours": "h", "s.v.days": "days", "s.v.step": "Step", "s.v.assigned": "Assigned to", "s.v.open.link": "Open the investigation",
    "s.v.disagrees": "Parent disagrees with the outcome", "s.v.acked": "Parent has acknowledged the outcome", "s.v.noresponse": "Waiting for the parent",
    "s.v.back": "← All investigations",
    "s.v.steps": "Steps", "s.v.done": "Done", "s.v.next": "Next step", "s.v.locked": "Not yet", "s.v.by": "by", "s.v.system": "the system",
    "s.v.markdone": "Mark as done", "s.v.stepsnote": "Steps are completed in order and cannot be skipped.",
    "s.step.opened": "Opened", "s.step.parent_called": "Parent called", "s.step.facts_gathered": "Facts gathered (staff statements, time, place)",
    "s.step.findings": "Findings written and shared with the parent", "s.step.actions_taken": "Actions taken",
    "s.step.parent_informed": "Parent informed", "s.step.closed": "Closed",
    "s.v.what": "What was reported", "s.v.child": "Child", "s.v.where": "Where and when",
    "s.v.notes": "Notes", "s.v.findings": "Findings for the parent", "s.v.findings.hint": "The parent sees this when the Findings step is done. Never write another child's name here.",
    "s.v.internal": "Internal findings", "s.v.statements": "Staff statements", "s.v.actions": "Actions taken",
    "s.v.private": "Only the manager and owner can see this. Never shown to parents or admin.",
    "s.v.save": "Save notes", "s.v.saved": "Saved.", "s.v.closedlock": "This investigation is closed and can no longer be changed.",
    "s.v.warn": "These notes mention another child:", "s.v.warn2": "Parents must never see other children's names. Please remove the name, or choose OK only if you are sure.",
    "s.v.needfindings": "Please write the findings for the parent first.", "s.v.needactions": "Please write the actions taken first.",
  };
  var ar = {
    "s.nav.investigations": "المراجعات",
    "s.v.title": "مراجعات السلامة", "s.v.none": "لا توجد مراجعات.", "s.v.open": "مفتوحة", "s.v.closed": "مغلقة",
    "s.v.kind.accident": "حادث", "s.v.kind.safety_concern": "قلق بشأن السلامة", "s.v.took": "استغرقت", "s.v.running": "مفتوحة منذ",
    "s.v.hours": "ساعة", "s.v.days": "يوم", "s.v.step": "الخطوة", "s.v.assigned": "المسؤول", "s.v.open.link": "فتح المراجعة",
    "s.v.disagrees": "وليّ الأمر لا يوافق على النتيجة", "s.v.acked": "اطلع وليّ الأمر على النتيجة", "s.v.noresponse": "في انتظار وليّ الأمر",
    "s.v.back": "→ كل المراجعات",
    "s.v.steps": "الخطوات", "s.v.done": "تمت", "s.v.next": "الخطوة التالية", "s.v.locked": "ليس بعد", "s.v.by": "بواسطة", "s.v.system": "النظام",
    "s.v.markdone": "تحديد كمُنجزة", "s.v.stepsnote": "تُنجز الخطوات بالترتيب ولا يمكن تخطيها.",
    "s.step.opened": "بدء المراجعة", "s.step.parent_called": "الاتصال بوليّ الأمر", "s.step.facts_gathered": "جمع المعلومات (أقوال الموظفين، الوقت، المكان)",
    "s.step.findings": "كتابة النتائج ومشاركتها مع وليّ الأمر", "s.step.actions_taken": "الإجراءات المتخذة",
    "s.step.parent_informed": "إبلاغ وليّ الأمر", "s.step.closed": "إغلاق المراجعة",
    "s.v.what": "ما تم الإبلاغ عنه", "s.v.child": "الطفل", "s.v.where": "المكان والوقت",
    "s.v.notes": "الملاحظات", "s.v.findings": "النتائج الموجهة لوليّ الأمر", "s.v.findings.hint": "يراها وليّ الأمر عند إنجاز خطوة النتائج. لا تكتب اسم أي طفل آخر هنا.",
    "s.v.internal": "النتائج الداخلية", "s.v.statements": "أقوال الموظفين", "s.v.actions": "الإجراءات المتخذة",
    "s.v.private": "يراها المدير والمالك فقط. لا تظهر لأولياء الأمور ولا للإدارة.",
    "s.v.save": "حفظ الملاحظات", "s.v.saved": "تم الحفظ.", "s.v.closedlock": "هذه المراجعة مغلقة ولا يمكن تغييرها.",
    "s.v.warn": "تذكر هذه الملاحظات طفلاً آخر:", "s.v.warn2": "يجب ألا يرى أولياء الأمور أسماء الأطفال الآخرين. يُرجى حذف الاسم، أو اختر موافق فقط إذا كنت متأكداً.",
    "s.v.needfindings": "يُرجى كتابة النتائج لوليّ الأمر أولاً.", "s.v.needactions": "يُرجى كتابة الإجراءات المتخذة أولاً.",
  };
  Object.assign(CKA.STR.en, en);
  Object.assign(CKA.STR.ar, ar);
})();
