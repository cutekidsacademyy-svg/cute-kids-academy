// Wording for the owner's checklist and task tracker, English and Arabic.
// Please have a native Arabic speaker review the Arabic before launch.
(function () {
  var en = {
    "s.nav.routine": "Checklist & tasks",
    "rt.title": "Checklist and tasks", "rt.privacy": "Private: only the owner can see this page.",
    "rt.day": "Day", "rt.today": "Today",
    "rt.morning": "Morning walk", "rt.afternoon": "Afternoon check", "rt.progress": "done",
    "rt.ok": "All good", "rt.attention": "Needs attention", "rt.note_ph": "What needs attention?", "rt.save": "Save", "rt.saved": "Saved ✓",
    "rt.needs_note": "Please say what needs attention.", "rt.err": "Could not save. Please try again.", "rt.not_done": "Not checked yet",
    "rt.history": "Last 7 days", "rt.date": "Date", "rt.complete": "Complete", "rt.nonworking": "Not a working day", "rt.attention_n": "needing attention",
    "rt.thu_title": "Thursday review", "rt.thu_hint": "Go through the late tasks below today.",
    "rt.late_tasks": "Late tasks", "rt.no_late": "No late tasks. Well done!",
    "rt.tasks": "Task tracker", "rt.what": "What", "rt.who": "Who", "rt.due": "Due", "rt.status": "Status",
    "rt.st.not_started": "Not started", "rt.st.in_progress": "In progress", "rt.st.done": "Done", "rt.st.late": "LATE",
    "rt.add_task": "Add a task", "rt.unassigned": "Nobody in particular", "rt.add": "Add", "rt.days_late": "days late", "rt.due_today": "due today",
    "rt.need_what": "Please say what the task is.", "rt.none": "No tasks yet.", "rt.done_recent": "Done in the last 2 weeks",
    "rt.edit": "Edit the checklist", "rt.edit_hint": "Change the wording, switch a check off, or add a new one. Changes apply from today.",
    "rt.item_active": "In use", "rt.new_item": "New check", "rt.add_item": "Add check", "rt.placeholder_note": "These first checks are placeholders: replace them with the ones from your follow-up plan.",
  };
  var ar = {
    "s.nav.routine": "القائمة والمهام",
    "rt.title": "القائمة والمهام", "rt.privacy": "خاصة: المالك فقط يستطيع رؤية هذه الصفحة.",
    "rt.day": "اليوم", "rt.today": "اليوم",
    "rt.morning": "جولة الصباح", "rt.afternoon": "فحص بعد الظهر", "rt.progress": "أُنجز",
    "rt.ok": "كل شيء على ما يرام", "rt.attention": "يحتاج إلى متابعة", "rt.note_ph": "ما الذي يحتاج إلى متابعة؟", "rt.save": "حفظ", "rt.saved": "تم الحفظ ✓",
    "rt.needs_note": "يُرجى كتابة ما يحتاج إلى متابعة.", "rt.err": "تعذّر الحفظ. يُرجى المحاولة مرة أخرى.", "rt.not_done": "لم يُفحص بعد",
    "rt.history": "آخر ٧ أيام", "rt.date": "التاريخ", "rt.complete": "مكتملة", "rt.nonworking": "ليس يوم عمل", "rt.attention_n": "تحتاج إلى متابعة",
    "rt.thu_title": "مراجعة الخميس", "rt.thu_hint": "راجع المهام المتأخرة أدناه اليوم.",
    "rt.late_tasks": "المهام المتأخرة", "rt.no_late": "لا توجد مهام متأخرة. أحسنت!",
    "rt.tasks": "متابعة المهام", "rt.what": "ماذا", "rt.who": "من", "rt.due": "الموعد", "rt.status": "الحالة",
    "rt.st.not_started": "لم تبدأ", "rt.st.in_progress": "قيد التنفيذ", "rt.st.done": "تمت", "rt.st.late": "متأخرة",
    "rt.add_task": "إضافة مهمة", "rt.unassigned": "لا أحد بعينه", "rt.add": "إضافة", "rt.days_late": "أيام تأخير", "rt.due_today": "موعدها اليوم",
    "rt.need_what": "يُرجى كتابة المهمة.", "rt.none": "لا توجد مهام بعد.", "rt.done_recent": "أُنجزت خلال الأسبوعين الماضيين",
    "rt.edit": "تعديل القائمة", "rt.edit_hint": "غيّر الصياغة أو أوقف بنداً أو أضف بنداً جديداً. تسري التغييرات من اليوم.",
    "rt.item_active": "مستخدم", "rt.new_item": "بند جديد", "rt.add_item": "إضافة بند", "rt.placeholder_note": "هذه البنود الأولى مجرد أمثلة: استبدلها بالبنود الواردة في خطة المتابعة الخاصة بك.",
  };
  Object.assign(CKA.STR.en, en);
  Object.assign(CKA.STR.ar, ar);
})();
