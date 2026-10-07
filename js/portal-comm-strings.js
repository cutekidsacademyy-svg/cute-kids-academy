// Wording for the parent's News, Calendar and Settings pages, English and Arabic. Please have a native Arabic speaker review it.
(function () {
  var en = {
    "p.nav.news": "News", "p.nav.calendar": "Calendar", "p.nav.settings": "Settings",
    "pn.title": "News", "pn.none": "No announcements yet.", "pn.important": "Important", "pn.new": "New", "pn.weekly": "Weekly update", "pn.back": "← All news", "pn.attachment": "Attachment", "pn.open": "Open",
    "cal.title": "Calendar", "cal.month": "Month", "cal.week": "Week", "cal.list": "List", "cal.today": "Today", "cal.prev": "Previous", "cal.next": "Next", "cal.nothing": "Nothing on this day.", "cal.nothing_list": "Nothing coming up.",
    "cal.k.event": "Event", "cal.k.closure": "Closed", "cal.k.holiday": "Holiday", "cal.k.session": "Session", "cal.k.deadline": "Answer by", "cal.menu": "Menu",
    "cal.m.breakfast": "Breakfast", "cal.m.lunch": "Lunch", "cal.m.snack": "Snack", "cal.allergy": "Contains something your child is allergic to:",
    "cal.place": "Where", "cal.cost": "Cost", "cal.egp": "EGP", "cal.all": "Everyone", "cal.class": "One class", "cal.all_day": "All day",
    "cal.approve": "Your answer", "cal.yes": "Yes, my child will come", "cal.no": "No", "cal.answered_yes": "You said yes", "cal.answered_no": "You said no", "cal.not_answered": "Not answered yet", "cal.deadline": "Please answer by",
    "cal.closed_answers": "The deadline has passed.", "cal.no_answer_not_approved": "The deadline has passed with no answer, so the academy counts this as not approved.", "cal.ics": "Add to my phone calendar", "cal.saved": "Thank you. Your answer was saved.", "cal.err": "That could not be saved. Please try again.", "cal.waiting": "Waiting for your answer",
    "cal.days": "Sun,Mon,Tue,Wed,Thu,Fri,Sat",
    "ps.title": "Settings", "ps.notify": "What should we tell you about?", "ps.notify_hint": "Every notification also arrives by email. Safety messages about your child (such as accident reports) cannot be switched off.",
    "ps.reports": "Daily reports", "ps.announcements": "Announcements", "ps.events": "Events and the calendar", "ps.cases": "Updates on your questions and concerns", "ps.save": "Save", "ps.saved": "Saved.", "ps.err": "That could not be saved. Please try again.",
    "ps.push": "Notifications on this device", "ps.push_hint": "Your phone shows only \"You have a new update\". Nothing about your child appears on the lock screen.", "ps.push_on": "Turn on notifications", "ps.push_off": "Turn off notifications",
    "ps.push_enabled": "Notifications are on for this device.", "ps.push_denied": "Notifications are blocked in your browser settings.", "ps.push_unavailable": "Notifications are not available on this device or are not switched on by the academy yet.",
    "ps.install": "Install the app", "ps.install_hint": "On your phone, open the browser menu and choose \"Add to Home screen\" (or \"Install app\").",
  };
  var ar = {
    "p.nav.news": "الأخبار", "p.nav.calendar": "التقويم", "p.nav.settings": "الإعدادات",
    "pn.title": "الأخبار", "pn.none": "لا توجد إعلانات بعد.", "pn.important": "مهم", "pn.new": "جديد", "pn.weekly": "التحديث الأسبوعي", "pn.back": "← كل الأخبار", "pn.attachment": "مرفق", "pn.open": "فتح",
    "cal.title": "التقويم", "cal.month": "شهر", "cal.week": "أسبوع", "cal.list": "قائمة", "cal.today": "اليوم", "cal.prev": "السابق", "cal.next": "التالي", "cal.nothing": "لا شيء في هذا اليوم.", "cal.nothing_list": "لا شيء قادم.",
    "cal.k.event": "فعالية", "cal.k.closure": "إغلاق", "cal.k.holiday": "إجازة", "cal.k.session": "حصة", "cal.k.deadline": "الرد قبل", "cal.menu": "قائمة الطعام",
    "cal.m.breakfast": "الفطور", "cal.m.lunch": "الغداء", "cal.m.snack": "وجبة خفيفة", "cal.allergy": "يحتوي على ما يسبب الحساسية لطفلك:",
    "cal.place": "المكان", "cal.cost": "التكلفة", "cal.egp": "ج.م", "cal.all": "الجميع", "cal.class": "فصل واحد", "cal.all_day": "طوال اليوم",
    "cal.approve": "ردّك", "cal.yes": "نعم، سيحضر طفلي", "cal.no": "لا", "cal.answered_yes": "أجبت بنعم", "cal.answered_no": "أجبت بلا", "cal.not_answered": "لم تُجب بعد", "cal.deadline": "يُرجى الرد قبل",
    "cal.closed_answers": "انتهى موعد الرد.", "cal.no_answer_not_approved": "انتهى الموعد دون ردّ، لذا تعدّ الحضانة ذلك غير موافقة.", "cal.ics": "إضافة إلى تقويم هاتفي", "cal.saved": "شكراً لك. تم حفظ ردّك.", "cal.err": "تعذّر الحفظ. يُرجى المحاولة مرة أخرى.", "cal.waiting": "بانتظار ردّك",
    "cal.days": "الأحد,الإثنين,الثلاثاء,الأربعاء,الخميس,الجمعة,السبت",
    "ps.title": "الإعدادات", "ps.notify": "بماذا نخبرك؟", "ps.notify_hint": "يصلك كل إشعار أيضاً بالبريد الإلكتروني. لا يمكن إيقاف رسائل السلامة الخاصة بطفلك (مثل تقارير الحوادث).",
    "ps.reports": "التقارير اليومية", "ps.announcements": "الإعلانات", "ps.events": "الفعاليات والتقويم", "ps.cases": "تحديثات أسئلتك وملاحظاتك", "ps.save": "حفظ", "ps.saved": "تم الحفظ.", "ps.err": "تعذّر الحفظ. يُرجى المحاولة مرة أخرى.",
    "ps.push": "الإشعارات على هذا الجهاز", "ps.push_hint": "يعرض هاتفك «لديك تحديث جديد» فقط. لا يظهر أي شيء عن طفلك على شاشة القفل.", "ps.push_on": "تفعيل الإشعارات", "ps.push_off": "إيقاف الإشعارات",
    "ps.push_enabled": "الإشعارات مفعّلة على هذا الجهاز.", "ps.push_denied": "الإشعارات محظورة في إعدادات المتصفح.", "ps.push_unavailable": "الإشعارات غير متاحة على هذا الجهاز أو لم تفعّلها الحضانة بعد.",
    "ps.install": "تثبيت التطبيق", "ps.install_hint": "على هاتفك افتح قائمة المتصفح واختر «إضافة إلى الشاشة الرئيسية» (أو «تثبيت التطبيق»).",
  };
  Object.assign(CKA.STR.en, en);
  Object.assign(CKA.STR.ar, ar);
})();
