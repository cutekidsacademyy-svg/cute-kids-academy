// Wording for the staff photos screen and the parent photos page, English and Arabic.
// Please have a native Arabic speaker review the Arabic before launch.
(function () {
  var en = {
    "s.nav.photos": "Photos", "p.nav.photos": "Photos",
    "ph.title": "Class photos and videos", "ph.intro": "Choose the photos or short videos (up to 60 seconds), tag the children who appear in each one, then upload. Parents only see items their own child is tagged in.",
    "ph.class": "Class", "ph.date": "Day", "ph.event": "Event (optional)", "ph.no_event": "No event", "ph.files": "Choose photos or videos", "ph.tag_all": "Tag the same children in every file", "ph.tags": "Who is in this one?",
    "ph.no_consent": "no consent for class photos", "ph.blocked_hint": "Children marked ⚠ cannot be tagged: their parents did not agree to class photos.", "ph.upload": "Upload", "ph.uploading": "Uploading…",
    "ph.saved": "Saved ✓", "ph.need_tag": "Tag at least one child.", "ph.too_long": "Videos can be at most 60 seconds.", "ph.too_big": "That file is too big (up to 50 MB).", "ph.bad_type": "Please choose a photo or a video.",
    "ph.consent_err": "Not saved: the parents of these children did not agree to class photos:", "ph.err": "That one could not be saved. Please try again.", "ph.no_children": "This class has no children yet.",
    "ph.gallery": "Recent items", "ph.none": "Nothing uploaded yet.", "ph.remove": "Remove", "ph.confirm_remove": "Remove this from every family?", "ph.removed": "Removed", "ph.video": "Video",
    "ph.post": "OK to post on social media", "ph.post_on": "Marked OK to post", "ph.post_err": "Not allowed: these children's parents did not agree to social media:", "ph.post_mark": "Mark OK to post", "ph.post_clear": "Clear the mark",
    "ph.archived": "Archived", "ph.retention": "How long photos are kept", "ph.months": "months", "ph.forever": "Keep for ever", "ph.after": "After that", "ph.a.delete": "Delete them", "ph.a.archive": "Hide them but keep them", "ph.save": "Save", "ph.saved_setting": "Setting saved.",
    "pp.title": "Photos", "pp.none": "No photos or videos of your child yet.", "pp.download": "Download", "pp.video": "Video", "pp.event": "Event", "pp.all": "All my children", "pp.pick": "Which child?",
  };
  var ar = {
    "s.nav.photos": "الصور", "p.nav.photos": "الصور",
    "ph.title": "صور وفيديوهات الفصل", "ph.intro": "اختر الصور أو الفيديوهات القصيرة (حتى 60 ثانية)، وحدّد الأطفال الظاهرين في كل منها، ثم ارفعها. يرى أولياء الأمور فقط ما وُسم فيه طفلهم.",
    "ph.class": "الفصل", "ph.date": "اليوم", "ph.event": "فعالية (اختياري)", "ph.no_event": "بدون فعالية", "ph.files": "اختر صوراً أو فيديوهات", "ph.tag_all": "وسم نفس الأطفال في كل الملفات", "ph.tags": "من في هذه الصورة؟",
    "ph.no_consent": "لا موافقة على صور الفصل", "ph.blocked_hint": "لا يمكن وسم الأطفال المعلَّمين بـ ⚠: لم يوافق أولياء أمورهم على صور الفصل.", "ph.upload": "رفع", "ph.uploading": "جارٍ الرفع…",
    "ph.saved": "تم الحفظ ✓", "ph.need_tag": "حدّد طفلاً واحداً على الأقل.", "ph.too_long": "الحد الأقصى للفيديو 60 ثانية.", "ph.too_big": "الملف كبير جداً (حتى 50 ميجابايت).", "ph.bad_type": "يُرجى اختيار صورة أو فيديو.",
    "ph.consent_err": "لم يُحفظ: لم يوافق أولياء أمور هؤلاء الأطفال على صور الفصل:", "ph.err": "تعذّر حفظ هذا الملف. يُرجى المحاولة مرة أخرى.", "ph.no_children": "لا يوجد أطفال في هذا الفصل بعد.",
    "ph.gallery": "أحدث العناصر", "ph.none": "لم يُرفع شيء بعد.", "ph.remove": "حذف", "ph.confirm_remove": "هل تريد حذف هذا لدى كل الأسر؟", "ph.removed": "محذوف", "ph.video": "فيديو",
    "ph.post": "مسموح بنشره على وسائل التواصل", "ph.post_on": "مُعلَّم بأنه مسموح بنشره", "ph.post_err": "غير مسموح: لم يوافق أولياء أمور هؤلاء الأطفال على وسائل التواصل:", "ph.post_mark": "تعليم كمسموح بنشره", "ph.post_clear": "إزالة العلامة",
    "ph.archived": "مؤرشف", "ph.retention": "مدة الاحتفاظ بالصور", "ph.months": "شهراً", "ph.forever": "الاحتفاظ دائماً", "ph.after": "بعد ذلك", "ph.a.delete": "حذفها", "ph.a.archive": "إخفاؤها مع الاحتفاظ بها", "ph.save": "حفظ", "ph.saved_setting": "تم حفظ الإعداد.",
    "pp.title": "الصور", "pp.none": "لا توجد صور أو فيديوهات لطفلك بعد.", "pp.download": "تنزيل", "pp.video": "فيديو", "pp.event": "فعالية", "pp.all": "كل أطفالي", "pp.pick": "أيّ طفل؟",
  };
  Object.assign(CKA.STR.en, en);
  Object.assign(CKA.STR.ar, ar);
})();
