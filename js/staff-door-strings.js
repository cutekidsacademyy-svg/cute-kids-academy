// Wording for the door screen (check-in, check-out, pickup check) and the attendance reports, English and Arabic.
// Please have a native Arabic speaker review the Arabic before launch.
(function () {
  var en = {
    "s.nav.door": "Door", "s.nav.attreport": "Attendance reports",
    "dr.title": "Door", "dr.today": "Today", "dr.refresh": "Refresh", "dr.empty": "There are no children to show.",
    "dr.t.present": "In now", "dr.t.waiting": "Not here yet", "dr.t.left": "Collected", "dr.t.absent": "Absent (told us)",
    "dr.status.waiting": "Not here yet", "dr.status.in": "In since", "dr.status.out": "Collected at", "dr.by": "by",
    "dr.checkin": "Check in", "dr.checkout": "Check out", "dr.undo": "Undo", "dr.undo_confirm": "Undo this?", "dr.cancel": "Cancel",
    "dr.notice.absence": "Parent says: absent", "dr.notice.late": "Parent says: coming late", "dr.expected": "expected about", "dr.came_anyway": "Notice from the parent: check the child in if they arrive.",
    "dr.flagged": "No news since 9:30. Please call the parent.", "dr.flag_title": "Not arrived and nobody told us", "dr.flag_hint": "These children have not arrived by 9:30 and the parents did not report an absence. Please call them.",
    "dr.show_phones": "Show parent phone numbers", "dr.called": "Called", "dr.i_called": "I called the parent", "dr.call_note": "What did the parent say?", "dr.call_save": "Save", "dr.call_need": "Please write what the parent said.",
    "dr.out_title": "Who is collecting?", "dr.out_hint": "Choose the person from the list and check their ID against the photo.", "dr.out_none": "No one is on this child's pickup list yet.",
    "dr.someone_else": "Someone else (not on the list)", "dr.id_photo": "ID photo", "dr.no_photo": "No ID photo",
    "dr.warn": "STOP. This person is NOT on the pickup list. Keep the child with you and call the parent.", "dr.warn_hint": "Only hand the child over if the parent confirms it by phone.",
    "dr.parents": "Parents", "dr.p_name": "Name of the person collecting", "dr.p_rel": "Relationship to the child", "dr.p_note": "Who approved it and how? (for example: mother, by phone, 14:05)",
    "dr.handover": "Hand over the child", "dr.handover_with": "Check out with", "dr.err.details": "Please write the person's name and relationship.", "dr.err.approval": "Please write who approved it and how. If the parent has not approved, keep the child.",
    "dr.done_out": "Checked out.", "dr.done_in": "Checked in.", "dr.overtime": "Overtime", "dr.min": "min", "dr.off_list": "Not on the list",
    "dr.working": "Working…", "dr.undone": "Undone.",
    "ar.title": "Attendance reports", "ar.privacy": "Attendance by class and by child, and the overtime minutes used for billing. Only admin, manager and owner can see this page.",
    "ar.week": "This week", "ar.month": "This month", "ar.custom": "Choose dates", "ar.from": "From", "ar.to": "To", "ar.show": "Show", "ar.badperiod": "Please choose a period of up to one year, with the end after the start.",
    "ar.note": "Counted days are school days (Sunday to Thursday) that have finished. A child is counted from the day they were enrolled.",
    "ar.by_class": "By class", "ar.by_child": "By child", "ar.overtime": "Overtime (for billing)", "ar.csv": "Download as CSV",
    "ar.class": "Class", "ar.child": "Child", "ar.children": "Children", "ar.days": "School days", "ar.present": "Present", "ar.absent_rep": "Absent (reported)", "ar.not_rep": "Absent (not reported)", "ar.late": "Late notices",
    "ar.ot_min": "Overtime minutes", "ar.ot_days": "Days with overtime", "ar.parents": "Parents", "ar.none": "Nothing to show for this period.",
  };
  var ar = {
    "s.nav.door": "الباب", "s.nav.attreport": "تقارير الحضور",
    "dr.title": "الباب", "dr.today": "اليوم", "dr.refresh": "تحديث", "dr.empty": "لا يوجد أطفال لعرضهم.",
    "dr.t.present": "داخل الحضانة", "dr.t.waiting": "لم يصل بعد", "dr.t.left": "تم استلامه", "dr.t.absent": "غائب (أخبرونا)",
    "dr.status.waiting": "لم يصل بعد", "dr.status.in": "حضر في", "dr.status.out": "استُلم في", "dr.by": "بواسطة",
    "dr.checkin": "تسجيل حضور", "dr.checkout": "تسجيل انصراف", "dr.undo": "تراجع", "dr.undo_confirm": "هل تريد التراجع؟", "dr.cancel": "إلغاء",
    "dr.notice.absence": "وليّ الأمر أبلغ: غائب", "dr.notice.late": "وليّ الأمر أبلغ: سيتأخر", "dr.expected": "الوصول المتوقع حوالي", "dr.came_anyway": "إشعار من وليّ الأمر: سجّل حضور الطفل إذا وصل.",
    "dr.flagged": "لا أخبار منذ 9:30. يُرجى الاتصال بوليّ الأمر.", "dr.flag_title": "لم يصل ولم يُبلَّغ عن غيابه", "dr.flag_hint": "هؤلاء الأطفال لم يصلوا حتى الساعة 9:30 ولم يُبلِّغ أولياء أمورهم عن الغياب. يُرجى الاتصال بهم.",
    "dr.show_phones": "إظهار أرقام أولياء الأمور", "dr.called": "تم الاتصال", "dr.i_called": "اتصلت بوليّ الأمر", "dr.call_note": "ماذا قال وليّ الأمر؟", "dr.call_save": "حفظ", "dr.call_need": "يُرجى كتابة ما قاله وليّ الأمر.",
    "dr.out_title": "من يستلم الطفل؟", "dr.out_hint": "اختر الشخص من القائمة وقارن بطاقة هويته بالصورة.", "dr.out_none": "لا يوجد أحد في قائمة استلام هذا الطفل بعد.",
    "dr.someone_else": "شخص آخر (ليس في القائمة)", "dr.id_photo": "صورة الهوية", "dr.no_photo": "لا توجد صورة هوية",
    "dr.warn": "توقّف. هذا الشخص ليس في قائمة الاستلام. أبقِ الطفل معك واتصل بوليّ الأمر.", "dr.warn_hint": "لا تسلّم الطفل إلا إذا أكّد وليّ الأمر ذلك هاتفياً.",
    "dr.parents": "أولياء الأمور", "dr.p_name": "اسم الشخص الذي يستلم الطفل", "dr.p_rel": "صلته بالطفل", "dr.p_note": "من وافق وكيف؟ (مثلاً: الأم، هاتفياً، 2:05 ظهراً)",
    "dr.handover": "تسليم الطفل", "dr.handover_with": "تسجيل انصراف مع", "dr.err.details": "يُرجى كتابة اسم الشخص وصلته بالطفل.", "dr.err.approval": "يُرجى كتابة من وافق وكيف. إذا لم يوافق وليّ الأمر فأبقِ الطفل.",
    "dr.done_out": "تم تسجيل الانصراف.", "dr.done_in": "تم تسجيل الحضور.", "dr.overtime": "وقت إضافي", "dr.min": "دقيقة", "dr.off_list": "ليس في القائمة",
    "dr.working": "جارٍ التنفيذ…", "dr.undone": "تم التراجع.",
    "ar.title": "تقارير الحضور", "ar.privacy": "الحضور حسب الفصل وحسب الطفل، ودقائق الوقت الإضافي المستخدمة في الفواتير. لا يرى هذه الصفحة إلا الإدارة والمدير والمالك.",
    "ar.week": "هذا الأسبوع", "ar.month": "هذا الشهر", "ar.custom": "اختر التواريخ", "ar.from": "من", "ar.to": "إلى", "ar.show": "عرض", "ar.badperiod": "يُرجى اختيار فترة لا تتجاوز سنة، وتاريخ النهاية بعد البداية.",
    "ar.note": "الأيام المحسوبة هي أيام الدراسة المنتهية (من الأحد إلى الخميس). يُحسب الطفل من يوم تسجيله.",
    "ar.by_class": "حسب الفصل", "ar.by_child": "حسب الطفل", "ar.overtime": "الوقت الإضافي (للفواتير)", "ar.csv": "تنزيل بصيغة CSV",
    "ar.class": "الفصل", "ar.child": "الطفل", "ar.children": "الأطفال", "ar.days": "أيام الدراسة", "ar.present": "حاضر", "ar.absent_rep": "غائب (مُبلَّغ)", "ar.not_rep": "غائب (غير مُبلَّغ)", "ar.late": "إشعارات التأخر",
    "ar.ot_min": "دقائق الوقت الإضافي", "ar.ot_days": "أيام بوقت إضافي", "ar.parents": "أولياء الأمور", "ar.none": "لا يوجد ما يُعرض لهذه الفترة.",
  };
  Object.assign(CKA.STR.en, en);
  Object.assign(CKA.STR.ar, ar);
})();
