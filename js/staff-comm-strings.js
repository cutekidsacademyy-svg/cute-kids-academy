// Wording for the staff announcements, menu and events screens, English and Arabic. Please have a native Arabic speaker review it.
(function () {
  var en = {
    "s.nav.announcements": "Announcements", "s.nav.menu": "Menu & schedule", "s.nav.events": "Events",
    "ca.title": "Announcements", "ca.new": "New announcement", "ca.none": "No announcements yet.", "ca.read": "read", "ca.of": "of", "ca.important": "Important", "ca.weekly": "Weekly update",
    "ca.f.title_en": "Title (English)", "ca.f.title_ar": "Title (Arabic)", "ca.f.body_en": "Message (English)", "ca.f.body_ar": "Message (Arabic)", "ca.f.audience": "Who is it for?",
    "ca.a.all": "Everyone", "ca.a.class": "One class", "ca.a.families": "Chosen families", "ca.f.class": "Class", "ca.f.children": "Choose the children whose families should get it",
    "ca.f.important": "Important (families who have not opened it are reminded after 24 hours)", "ca.f.file": "Attach an image or a PDF (optional, up to 10 MB)",
    "ca.f.weekly": "Start the Thursday weekly update", "ca.weekly_hint": "Fills in next week's menu, then add the activities and reminders.", "ca.post": "Post it", "ca.cancel": "Cancel",
    "ca.need_title": "Please write a title and a message in at least one language.", "ca.need_class": "Please choose a class.", "ca.need_children": "Please choose at least one child.", "ca.err": "That could not be posted. Please try again.", "ca.posted": "Posted. The families have been emailed.",
    "ca.file_bad": "Please choose a PDF or an image under 10 MB.", "ca.working": "Working…",
    "ca.stats": "Who has read it", "ca.unread": "Not opened yet", "ca.readers": "Opened by", "ca.remove": "Delete this announcement", "ca.confirm_remove": "Delete this announcement for everyone?", "ca.close": "Close",
    "ca.weekly_title": "Weekly update", "ca.weekly_menu": "Next week's menu", "ca.weekly_acts": "Activities next week:", "ca.weekly_rem": "Reminders:",
    "cm.title": "Menu and daily schedule", "cm.week_of": "Week of", "cm.prev": "Previous week", "cm.next": "Next week", "cm.breakfast": "Breakfast", "cm.lunch": "Lunch", "cm.snack": "Snack", "cm.en": "English", "cm.ar": "Arabic",
    "cm.allergens": "Contains", "cm.save": "Save", "cm.saved": "Saved.", "cm.err": "That could not be saved.", "cm.hint": "Leave both dish boxes empty to remove a dish. Families whose child has a matching allergy are warned automatically.",
    "al.peanuts": "Peanuts", "al.tree_nuts": "Tree nuts", "al.milk": "Milk", "al.eggs": "Eggs", "al.wheat": "Wheat", "al.soy": "Soy", "al.fish": "Fish", "al.shellfish": "Shellfish", "al.sesame": "Sesame",
    "cm.affected": "Children who must not eat this:",
    "cm.schedule": "Daily class schedule", "cm.sched_hint": "Shown on the parents' home screen. Choose a class, or everyone.", "cm.sched_all": "Every class", "cm.time": "Time", "cm.sched_title": "What happens", "cm.add": "Add", "cm.delete": "Delete", "cm.sched_need": "Please give a time and a title.",
    "ce.title": "Events and calendar", "ce.new": "New calendar item", "ce.none": "Nothing in the calendar yet.", "ce.kind": "Type", "ce.k.event": "Event", "ce.k.closure": "Closure", "ce.k.holiday": "Holiday", "ce.k.session": "Specialist session",
    "ce.f.title_en": "Title (English)", "ce.f.title_ar": "Title (Arabic)", "ce.f.details_en": "Details (English)", "ce.f.details_ar": "Details (Arabic)", "ce.f.starts": "Starts", "ce.f.ends": "Ends (optional)", "ce.f.all_day": "All day",
    "ce.f.place": "Place", "ce.f.cost": "Cost (EGP, optional)", "ce.f.audience": "Who is it for?", "ce.f.needs": "Parents must approve (yes or no)", "ce.f.deadline": "Answer deadline", "ce.save": "Save", "ce.edit": "Edit", "ce.delete": "Delete", "ce.confirm_delete": "Delete this calendar item?",
    "ce.need": "Please give a title and a start time.", "ce.need_deadline": "Please choose an answer deadline before the event starts.", "ce.saved": "Saved.", "ce.err": "That could not be saved.", "ce.answers": "Answers", "ce.yes": "Yes", "ce.no": "No", "ce.missing": "Not answered",
    "ce.family": "Family", "ce.answered_by": "Answered by", "ce.counts": "yes / no / waiting", "ce.upcoming": "Upcoming", "ce.past": "Past",
  };
  var ar = {
    "s.nav.announcements": "الإعلانات", "s.nav.menu": "القائمة والجدول", "s.nav.events": "الفعاليات",
    "ca.title": "الإعلانات", "ca.new": "إعلان جديد", "ca.none": "لا توجد إعلانات بعد.", "ca.read": "قرأ", "ca.of": "من", "ca.important": "مهم", "ca.weekly": "التحديث الأسبوعي",
    "ca.f.title_en": "العنوان (إنجليزي)", "ca.f.title_ar": "العنوان (عربي)", "ca.f.body_en": "الرسالة (إنجليزي)", "ca.f.body_ar": "الرسالة (عربي)", "ca.f.audience": "لمن هو؟",
    "ca.a.all": "للجميع", "ca.a.class": "فصل واحد", "ca.a.families": "أسر محددة", "ca.f.class": "الفصل", "ca.f.children": "اختر الأطفال الذين ستصل أسرهم الرسالة",
    "ca.f.important": "مهم (تُذكَّر الأسر التي لم تفتحه بعد 24 ساعة)", "ca.f.file": "إرفاق صورة أو ملف PDF (اختياري، حتى 10 ميجابايت)",
    "ca.f.weekly": "بدء التحديث الأسبوعي ليوم الخميس", "ca.weekly_hint": "يملأ قائمة الطعام للأسبوع القادم، ثم أضف الأنشطة والتذكيرات.", "ca.post": "نشر", "ca.cancel": "إلغاء",
    "ca.need_title": "يُرجى كتابة عنوان ورسالة بلغة واحدة على الأقل.", "ca.need_class": "يُرجى اختيار فصل.", "ca.need_children": "يُرجى اختيار طفل واحد على الأقل.", "ca.err": "تعذّر النشر. يُرجى المحاولة مرة أخرى.", "ca.posted": "تم النشر. أُرسلت رسائل إلى الأسر.",
    "ca.file_bad": "يُرجى اختيار ملف PDF أو صورة أقل من 10 ميجابايت.", "ca.working": "جارٍ التنفيذ…",
    "ca.stats": "من قرأه", "ca.unread": "لم يفتحه بعد", "ca.readers": "فتحه", "ca.remove": "حذف هذا الإعلان", "ca.confirm_remove": "هل تريد حذف هذا الإعلان للجميع؟", "ca.close": "إغلاق",
    "ca.weekly_title": "التحديث الأسبوعي", "ca.weekly_menu": "قائمة الطعام للأسبوع القادم", "ca.weekly_acts": "أنشطة الأسبوع القادم:", "ca.weekly_rem": "تذكيرات:",
    "cm.title": "قائمة الطعام والجدول اليومي", "cm.week_of": "أسبوع", "cm.prev": "الأسبوع السابق", "cm.next": "الأسبوع التالي", "cm.breakfast": "الفطور", "cm.lunch": "الغداء", "cm.snack": "وجبة خفيفة", "cm.en": "إنجليزي", "cm.ar": "عربي",
    "cm.allergens": "يحتوي على", "cm.save": "حفظ", "cm.saved": "تم الحفظ.", "cm.err": "تعذّر الحفظ.", "cm.hint": "اترك خانتي الطبق فارغتين لحذفه. تُنبَّه الأسر التي لدى طفلها حساسية مطابقة تلقائياً.",
    "al.peanuts": "فول سوداني", "al.tree_nuts": "مكسرات", "al.milk": "حليب", "al.eggs": "بيض", "al.wheat": "قمح", "al.soy": "صويا", "al.fish": "سمك", "al.shellfish": "محار وجمبري", "al.sesame": "سمسم",
    "cm.affected": "أطفال لا يجوز أن يأكلوا هذا:",
    "cm.schedule": "الجدول اليومي للفصل", "cm.sched_hint": "يظهر في الشاشة الرئيسية لأولياء الأمور. اختر فصلاً أو الجميع.", "cm.sched_all": "كل الفصول", "cm.time": "الوقت", "cm.sched_title": "ماذا يحدث", "cm.add": "إضافة", "cm.delete": "حذف", "cm.sched_need": "يُرجى كتابة الوقت والعنوان.",
    "ce.title": "الفعاليات والتقويم", "ce.new": "عنصر جديد في التقويم", "ce.none": "لا شيء في التقويم بعد.", "ce.kind": "النوع", "ce.k.event": "فعالية", "ce.k.closure": "إغلاق", "ce.k.holiday": "إجازة", "ce.k.session": "حصة متخصصة",
    "ce.f.title_en": "العنوان (إنجليزي)", "ce.f.title_ar": "العنوان (عربي)", "ce.f.details_en": "التفاصيل (إنجليزي)", "ce.f.details_ar": "التفاصيل (عربي)", "ce.f.starts": "يبدأ", "ce.f.ends": "ينتهي (اختياري)", "ce.f.all_day": "طوال اليوم",
    "ce.f.place": "المكان", "ce.f.cost": "التكلفة (جنيه، اختياري)", "ce.f.audience": "لمن هو؟", "ce.f.needs": "يجب أن يوافق أولياء الأمور (نعم أو لا)", "ce.f.deadline": "آخر موعد للرد", "ce.save": "حفظ", "ce.edit": "تعديل", "ce.delete": "حذف", "ce.confirm_delete": "هل تريد حذف هذا العنصر من التقويم؟",
    "ce.need": "يُرجى كتابة عنوان ووقت البدء.", "ce.need_deadline": "يُرجى اختيار آخر موعد للرد قبل بدء الفعالية.", "ce.saved": "تم الحفظ.", "ce.err": "تعذّر الحفظ.", "ce.answers": "الردود", "ce.yes": "نعم", "ce.no": "لا", "ce.missing": "لم يجب",
    "ce.family": "الأسرة", "ce.answered_by": "أجاب", "ce.counts": "نعم / لا / بالانتظار", "ce.upcoming": "القادمة", "ce.past": "السابقة",
  };
  Object.assign(CKA.STR.en, en);
  Object.assign(CKA.STR.ar, ar);
})();
