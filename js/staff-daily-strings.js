// Wording for the staff daily-reports screen, English and Arabic. Please have a native Arabic speaker review the Arabic.
(function () {
  var en = {
    "s.nav.daily": "Daily reports",
    "dl.title": "Daily reports", "dl.intro": "Tap entries during the day. Only children who are checked in at the door appear here. Reports stay private until they are sent.",
    "dl.t.in": "Checked in", "dl.t.draft": "Ready to send", "dl.t.sent": "Sent", "dl.t.note": "Need a note", "dl.empty": "No child is checked in yet. Check children in at the Door first.",
    "dl.nudge": "It is after 4 pm. These children still need one personal sentence:", "dl.refresh": "Refresh",
    "dl.select_all": "Select everyone", "dl.select_none": "Clear selection", "dl.selected": "selected", "dl.bulk": "Apply to everyone selected", "dl.bulk_none": "Tick the children first.",
    "dl.lunch": "Lunch", "dl.lunch.more": "More (seconds)", "dl.lunch.all": "All", "dl.lunch.half": "Half", "dl.lunch.little": "A little", "dl.lunch.none": "None",
    "dl.mood": "Mood", "dl.mood.happy": "😀 Happy", "dl.mood.calm": "😌 Calm", "dl.mood.tired": "😴 Tired", "dl.mood.upset": "😢 Upset",
    "dl.water": "Water (cups)", "dl.milk": "Milk (ml)", "dl.sleep": "Sleep today", "dl.diapers": "Diaper changes", "dl.stool": "Stools", "dl.temp": "Temperature (°C), only if checked",
    "dl.temp_alert": "38 °C or more: the class staff and the admins are alerted when you save. Please also call the parent.",
    "dl.note": "One personal sentence for the parent", "dl.note_ph": "For example: Salma loved painting today and shared her crayons.",
    "dl.allergy": "ALLERGY", "dl.allergy_warn": "Check this before every meal:",
    "dl.send_for": "Kindly send for tomorrow", "dl.i.diapers": "Diapers", "dl.i.wipes": "Wipes", "dl.i.shower_gel": "Shower gel", "dl.i.cotton": "Cotton", "dl.i.extra_clothes": "Extra clothes", "dl.i.other": "Other", "dl.other_ph": "What should they send?",
    "dl.open": "Open", "dl.close": "Close", "dl.save": "Save", "dl.save_send": "Save and send to parents", "dl.send_all": "Send all ready reports", "dl.send_confirm": "Send every report that has entries to the parents now?",
    "dl.saved": "Saved.", "dl.sent_n": "reports sent.", "dl.nothing_to_send": "There is nothing ready to send.",
    "dl.st.none": "Not started", "dl.st.draft": "Draft", "dl.st.sent": "Sent", "dl.checked_out": "Left", "dl.min": "min", "dl.h": "h",
    "dl.err.checked_in": "This child must be checked in at the Door first.", "dl.err.sent": "This report was already sent. Ask the admin to change it.", "dl.err.value": "One of the values is not possible. Please check the numbers.",
    "dl.edit_sent": "Change this sent report (recorded)", "dl.reason": "Why are you changing it? The parents' report changes, and this is recorded.", "dl.reason_need": "Please write the reason.", "dl.edit_save": "Save the change",
    "dl.ov.title": "Today at a glance", "dl.ov.present": "Children present", "dl.ov.sent": "Reports sent", "dl.ov.ready": "Ready, not sent", "dl.ov.notstarted": "Nothing entered yet", "dl.ov.nonote": "Children without a personal sentence", "dl.ov.fever": "High temperatures (38 °C or more)", "dl.ov.none": "None",
    "dl.set.title": "Automatic sending", "dl.set.auto": "Send reports automatically", "dl.set.time": "At this time (before pickup)", "dl.set.save": "Save setting", "dl.set.saved": "Setting saved.", "dl.set.err": "Please choose a time between 12:00 and 17:45.",
  };
  var ar = {
    "s.nav.daily": "التقارير اليومية",
    "dl.title": "التقارير اليومية", "dl.intro": "سجّل الإدخالات خلال اليوم. يظهر هنا الأطفال الذين سُجّل حضورهم عند الباب فقط. تبقى التقارير خاصة حتى تُرسل.",
    "dl.t.in": "حضروا", "dl.t.draft": "جاهزة للإرسال", "dl.t.sent": "أُرسلت", "dl.t.note": "تحتاج جملة", "dl.empty": "لم يُسجَّل حضور أي طفل بعد. سجّل حضور الأطفال عند الباب أولاً.",
    "dl.nudge": "تجاوزت الساعة 4 مساءً. هؤلاء الأطفال ما زالوا بحاجة إلى جملة شخصية واحدة:", "dl.refresh": "تحديث",
    "dl.select_all": "تحديد الجميع", "dl.select_none": "إلغاء التحديد", "dl.selected": "محدد", "dl.bulk": "تطبيق على المحددين", "dl.bulk_none": "حدّد الأطفال أولاً.",
    "dl.lunch": "الغداء", "dl.lunch.more": "أكثر (طلب المزيد)", "dl.lunch.all": "كله", "dl.lunch.half": "النصف", "dl.lunch.little": "القليل", "dl.lunch.none": "لم يأكل",
    "dl.mood": "المزاج", "dl.mood.happy": "😀 سعيد", "dl.mood.calm": "😌 هادئ", "dl.mood.tired": "😴 متعب", "dl.mood.upset": "😢 منزعج",
    "dl.water": "الماء (أكواب)", "dl.milk": "الحليب (مل)", "dl.sleep": "النوم اليوم", "dl.diapers": "تغيير الحفاضات", "dl.stool": "مرات التبرز", "dl.temp": "الحرارة (°م) عند القياس فقط",
    "dl.temp_alert": "38 °م أو أكثر: يُنبَّه معلمو الفصل والإدارة عند الحفظ. يُرجى أيضاً الاتصال بوليّ الأمر.",
    "dl.note": "جملة شخصية واحدة لوليّ الأمر", "dl.note_ph": "مثلاً: أحبّت سلمى الرسم اليوم وشاركت ألوانها.",
    "dl.allergy": "حساسية", "dl.allergy_warn": "راجع هذا قبل كل وجبة:",
    "dl.send_for": "يُرجى إرسال غداً", "dl.i.diapers": "حفاضات", "dl.i.wipes": "مناديل مبللة", "dl.i.shower_gel": "جل استحمام", "dl.i.cotton": "قطن", "dl.i.extra_clothes": "ملابس إضافية", "dl.i.other": "أخرى", "dl.other_ph": "ماذا يرسلون؟",
    "dl.open": "فتح", "dl.close": "إغلاق", "dl.save": "حفظ", "dl.save_send": "حفظ وإرسال إلى أولياء الأمور", "dl.send_all": "إرسال كل التقارير الجاهزة", "dl.send_confirm": "هل تريد إرسال كل تقرير فيه إدخالات إلى أولياء الأمور الآن؟",
    "dl.saved": "تم الحفظ.", "dl.sent_n": "تقارير أُرسلت.", "dl.nothing_to_send": "لا يوجد شيء جاهز للإرسال.",
    "dl.st.none": "لم يبدأ", "dl.st.draft": "مسودة", "dl.st.sent": "أُرسل", "dl.checked_out": "غادر", "dl.min": "د", "dl.h": "س",
    "dl.err.checked_in": "يجب تسجيل حضور هذا الطفل عند الباب أولاً.", "dl.err.sent": "أُرسل هذا التقرير بالفعل. اطلب من الإدارة تعديله.", "dl.err.value": "إحدى القيم غير ممكنة. يُرجى مراجعة الأرقام.",
    "dl.edit_sent": "تعديل هذا التقرير المُرسل (يُسجَّل)", "dl.reason": "لماذا تعدّله؟ سيتغير تقرير وليّ الأمر ويُسجَّل ذلك.", "dl.reason_need": "يُرجى كتابة السبب.", "dl.edit_save": "حفظ التعديل",
    "dl.ov.title": "اليوم في لمحة", "dl.ov.present": "الأطفال الحاضرون", "dl.ov.sent": "تقارير أُرسلت", "dl.ov.ready": "جاهزة ولم تُرسل", "dl.ov.notstarted": "لم يُدخل شيء بعد", "dl.ov.nonote": "أطفال بلا جملة شخصية", "dl.ov.fever": "ارتفاع الحرارة (38 °م أو أكثر)", "dl.ov.none": "لا أحد",
    "dl.set.title": "الإرسال التلقائي", "dl.set.auto": "إرسال التقارير تلقائياً", "dl.set.time": "في هذا الوقت (قبل الاستلام)", "dl.set.save": "حفظ الإعداد", "dl.set.saved": "تم حفظ الإعداد.", "dl.set.err": "يُرجى اختيار وقت بين 12:00 و17:45.",
  };
  Object.assign(CKA.STR.en, en);
  Object.assign(CKA.STR.ar, ar);
})();
