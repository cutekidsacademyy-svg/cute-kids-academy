// Wording for the absence tracker, the 3-day follow-up and "email to case". English and Arabic.
// Please have a native Arabic speaker review the Arabic (especially the two parent messages) before launch.
(function () {
  var en = {
    "s.nav.absences": "Absences",
    "ab.title": "Absences", "ab.tab.followups": "Follow-ups", "ab.tab.tracker": "Tracker", "ab.tab.email": "From an email",
    "ab.f.intro": "Children absent 3 or more school days in a row. A check-in message must be sent to the family before 6 pm on the day the task appears.", "ab.f.none": "No follow-ups right now.", "ab.f.closed": "Closed in the last 2 weeks",
    "ab.k.check_in": "Check-in", "ab.k.reminder": "Second reminder", "ab.k.call": "Phone call", "ab.days": "days missed", "ab.since": "since", "ab.overdue": "Not sent in time", "ab.escalated": "Escalated to the manager and owner",
    "ab.reasons": "What the parents told us", "ab.no_reason": "No reason given", "ab.not_reported": "not reported", "ab.parents": "Parents",
    "ab.msg": "Message to the family", "ab.tpl": "Start from", "ab.tpl_reason": "A reason was given (caring check-in)", "ab.tpl_noreason": "No reason given", "ab.lang": "Language", "ab.send": "Send through the portal and email", "ab.sent": "Sent. Both parents were told.", "ab.sent_at": "Sent",
    "ab.whatsapp": "Open WhatsApp", "ab.call": "Call",
    "ab.msg.reason_en": "We miss {child}! We hope they're feeling better. Let us know if there's anything we can do.", "ab.msg.noreason_en": "We've missed {child} for the past {days} days. Is everything OK? Please let us know when we should expect them back.",
    "ab.msg.reason_ar": "اشتقنا إلى {child}! نتمنى أن يكون بخير. أخبرونا إن كان بإمكاننا فعل أي شيء.", "ab.msg.noreason_ar": "افتقدنا {child} خلال الأيام {days} الماضية. هل كل شيء على ما يرام؟ يُرجى إخبارنا متى نتوقع عودته.",
    "ab.outcome": "What happened?", "ab.o.parent_replied": "The parent replied", "ab.o.returning": "The child is returning on…", "ab.o.considering_leaving": "The family is considering leaving", "ab.o.no_reply": "No reply", "ab.return_date": "Return date",
    "ab.outcome_save": "Save", "ab.outcome_need_date": "Please choose the return date.", "ab.outcome_saved": "Saved.", "ab.err": "That could not be done.", "ab.call_task": "No reply to the messages. Please phone the family, then record what happened.",
    "ab.tr.period": "Period", "ab.tr.week": "This week", "ab.tr.month": "This month", "ab.tr.60": "Last 60 days", "ab.tr.child": "Child", "ab.tr.class": "Class", "ab.tr.absent": "Absent days", "ab.tr.reported": "Reported (with reason)", "ab.tr.notrep": "Not reported",
    "ab.tr.streak": "Days in a row now", "ab.tr.last": "Last attended", "ab.tr.reason": "Last reason", "ab.tr.t_absent": "Absence days", "ab.tr.t_reported": "Reported by parents", "ab.tr.t_not": "Not reported", "ab.tr.t_flag": "Children absent 3+ days in a row",
    "ab.tr.csv": "Download as CSV", "ab.tr.add": "Record an absence", "ab.tr.add_child": "Child", "ab.tr.add_date": "Day", "ab.tr.add_reported": "A parent reported it", "ab.tr.add_reason": "Reason the parent gave", "ab.tr.add_btn": "Record", "ab.tr.added": "Recorded.",
    "ab.tr.flagged": "3+ days in a row", "ab.tr.none": "Nothing to show.", "ab.tr.note": "Counted days are school days (Sunday to Thursday, not closures or holidays in the calendar) that have finished.",
    "ab.em.title": "Turn an email into a portal case", "ab.em.hint": "Find the family, paste the email, choose how urgent it is. The family sees it as a case, and your reply reaches them in the portal and by email.", "ab.em.search": "Find the parent (name, email, phone or child)",
    "ab.em.sender": "Who wrote it (their email address)", "ab.em.subject": "Subject", "ab.em.body": "The message", "ab.em.urgency": "Urgency", "ab.em.urgent": "Urgent", "ab.em.can_wait": "Can wait", "ab.em.child": "Child", "ab.em.create": "Create the case", "ab.em.created": "The case was created.",
    "ab.em.open": "Open the case", "ab.em.need": "Please choose the parent and child and fill in the subject and message.",
    "ab.stats.title": "Absence follow-ups", "ab.stats.created": "Follow-ups", "ab.stats.on_time": "Sent on time", "ab.stats.escalated": "Escalated", "ab.stats.replied": "Parent replied", "ab.stats.returning": "Returning", "ab.stats.leaving": "Considering leaving", "ab.stats.no_reply": "No reply",
  };
  var ar = {
    "s.nav.absences": "الغياب",
    "ab.title": "الغياب", "ab.tab.followups": "المتابعات", "ab.tab.tracker": "الرصد", "ab.tab.email": "من بريد إلكتروني",
    "ab.f.intro": "أطفال غابوا ٣ أيام دراسية متتالية أو أكثر. يجب إرسال رسالة اطمئنان إلى الأسرة قبل الساعة ٦ مساءً في اليوم الذي تظهر فيه المهمة.", "ab.f.none": "لا توجد متابعات الآن.", "ab.f.closed": "أُغلقت خلال الأسبوعين الماضيين",
    "ab.k.check_in": "اطمئنان", "ab.k.reminder": "تذكير ثانٍ", "ab.k.call": "مكالمة هاتفية", "ab.days": "أيام غياب", "ab.since": "منذ", "ab.overdue": "لم تُرسل في الوقت", "ab.escalated": "تم التصعيد إلى المدير والمالك",
    "ab.reasons": "ما أخبرنا به أولياء الأمور", "ab.no_reason": "لم يُذكر سبب", "ab.not_reported": "غير مُبلَّغ", "ab.parents": "أولياء الأمور",
    "ab.msg": "الرسالة إلى الأسرة", "ab.tpl": "البدء من", "ab.tpl_reason": "ذُكر سبب (رسالة اطمئنان)", "ab.tpl_noreason": "لم يُذكر سبب", "ab.lang": "اللغة", "ab.send": "إرسال عبر البوابة والبريد", "ab.sent": "تم الإرسال. أُبلغ كلا الوالدين.", "ab.sent_at": "أُرسلت",
    "ab.whatsapp": "فتح واتساب", "ab.call": "اتصال",
    "ab.msg.reason_en": "We miss {child}! We hope they're feeling better. Let us know if there's anything we can do.", "ab.msg.noreason_en": "We've missed {child} for the past {days} days. Is everything OK? Please let us know when we should expect them back.",
    "ab.msg.reason_ar": "اشتقنا إلى {child}! نتمنى أن يكون بخير. أخبرونا إن كان بإمكاننا فعل أي شيء.", "ab.msg.noreason_ar": "افتقدنا {child} خلال الأيام {days} الماضية. هل كل شيء على ما يرام؟ يُرجى إخبارنا متى نتوقع عودته.",
    "ab.outcome": "ماذا حدث؟", "ab.o.parent_replied": "ردّ وليّ الأمر", "ab.o.returning": "سيعود الطفل في…", "ab.o.considering_leaving": "الأسرة تفكر في المغادرة", "ab.o.no_reply": "لا رد", "ab.return_date": "تاريخ العودة",
    "ab.outcome_save": "حفظ", "ab.outcome_need_date": "يُرجى اختيار تاريخ العودة.", "ab.outcome_saved": "تم الحفظ.", "ab.err": "تعذّر تنفيذ ذلك.", "ab.call_task": "لا ردّ على الرسائل. يُرجى الاتصال بالأسرة ثم تسجيل ما حدث.",
    "ab.tr.period": "الفترة", "ab.tr.week": "هذا الأسبوع", "ab.tr.month": "هذا الشهر", "ab.tr.60": "آخر ٦٠ يوماً", "ab.tr.child": "الطفل", "ab.tr.class": "الفصل", "ab.tr.absent": "أيام الغياب", "ab.tr.reported": "مُبلَّغ (مع السبب)", "ab.tr.notrep": "غير مُبلَّغ",
    "ab.tr.streak": "أيام متتالية الآن", "ab.tr.last": "آخر حضور", "ab.tr.reason": "آخر سبب", "ab.tr.t_absent": "أيام الغياب", "ab.tr.t_reported": "أبلغ بها أولياء الأمور", "ab.tr.t_not": "غير مُبلَّغ", "ab.tr.t_flag": "أطفال غابوا ٣ أيام متتالية أو أكثر",
    "ab.tr.csv": "تنزيل بصيغة CSV", "ab.tr.add": "تسجيل غياب", "ab.tr.add_child": "الطفل", "ab.tr.add_date": "اليوم", "ab.tr.add_reported": "أبلغ وليّ الأمر عنه", "ab.tr.add_reason": "السبب الذي ذكره وليّ الأمر", "ab.tr.add_btn": "تسجيل", "ab.tr.added": "تم التسجيل.",
    "ab.tr.flagged": "٣ أيام متتالية أو أكثر", "ab.tr.none": "لا يوجد ما يُعرض.", "ab.tr.note": "الأيام المحسوبة هي أيام دراسية (من الأحد إلى الخميس، دون الإغلاقات والإجازات في التقويم) انتهت بالفعل.",
    "ab.em.title": "تحويل رسالة بريد إلكتروني إلى طلب في البوابة", "ab.em.hint": "ابحث عن الأسرة والصق الرسالة واختر درجة الاستعجال. ترى الأسرة الطلب في البوابة ويصلها ردّك في البوابة وبالبريد.", "ab.em.search": "ابحث عن وليّ الأمر (الاسم أو البريد أو الهاتف أو الطفل)",
    "ab.em.sender": "من كتبها (بريده الإلكتروني)", "ab.em.subject": "الموضوع", "ab.em.body": "الرسالة", "ab.em.urgency": "درجة الاستعجال", "ab.em.urgent": "عاجل", "ab.em.can_wait": "يمكن الانتظار", "ab.em.child": "الطفل", "ab.em.create": "إنشاء الطلب", "ab.em.created": "تم إنشاء الطلب.",
    "ab.em.open": "فتح الطلب", "ab.em.need": "يُرجى اختيار وليّ الأمر والطفل وكتابة الموضوع والرسالة.",
    "ab.stats.title": "متابعات الغياب", "ab.stats.created": "المتابعات", "ab.stats.on_time": "أُرسلت في الوقت", "ab.stats.escalated": "تم تصعيدها", "ab.stats.replied": "ردّ وليّ الأمر", "ab.stats.returning": "سيعود", "ab.stats.leaving": "يفكرون في المغادرة", "ab.stats.no_reply": "لا رد",
  };
  Object.assign(CKA.STR.en, en);
  Object.assign(CKA.STR.ar, ar);
})();
