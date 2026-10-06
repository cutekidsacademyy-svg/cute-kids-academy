// Wording for the manager/owner report page, English and Arabic. The "rp.*" keys are the table
// headings shared with the CSV download. Please have a native Arabic speaker review the Arabic.
(function () {
  var en = {
    "s.nav.reports": "Reports",
    "s.rp.title": "Reports", "s.rp.privacy": "Only the manager and owner can see this page.",
    "s.rp.week": "This week", "s.rp.month": "This month", "s.rp.custom": "Custom range", "s.rp.from": "From", "s.rp.to": "To",
    "s.rp.show": "Show", "s.rp.csv": "Download CSV", "s.rp.period": "Period", "s.rp.badperiod": "Please choose a valid range, with the start before the end.",
    "s.rp.note": "Cases are counted by the day they arrived. \"On time\" compares the time acknowledged or resolved with what the parent was promised. \"Overdue now\" and \"investigations still open\" are about right now. Ratings show the month the period ends in, beside the month before.",
    "s.rp.none": "Nothing in this period.",
    "rp.summary": "Summary", "rp.metric": "Measure", "rp.value": "Value", "rp.received": "Cases received", "rp.open_now": "Open now", "rp.overdue_now": "Overdue now",
    "rp.ack_on_time": "Acknowledged on time", "rp.res_on_time": "Resolved on time", "rp.avg_resolve": "Average time to resolve (hours)",
    "rp.esc_cases": "Cases escalated", "rp.esc_moves": "Escalation moves", "rp.sat_yes": "Parent satisfied: yes", "rp.sat_no": "Parent satisfied: no",
    "rp.sat_waiting": "Resolved, waiting for the parent's answer", "rp.acc_total": "Accidents logged", "rp.open_inv": "Investigations still open",
    "rp.by_type_urgency": "Cases by type and urgency", "rp.type": "Type", "rp.urgency": "Urgency", "rp.count": "Number",
    "rp.type.complaint": "Concern", "rp.type.safety_concern": "Safety concern", "rp.urg.critical": "Critical", "rp.urg.urgent": "Urgent", "rp.urg.can_wait": "Can wait",
    "rp.esc_by_level": "Escalations, by the level reached", "rp.level": "Level",
    "rp.acc_by_class": "Accidents by class", "rp.class": "Class", "rp.acc_by_location": "Accidents by location", "rp.location": "Location",
    "rp.acc_by_severity": "Accidents by severity", "rp.severity": "Severity", "rp.sev.minor": "Minor", "rp.sev.needs_attention": "Needs attention", "rp.sev.serious": "Serious",
    "rp.ratings": "Parent ratings by class (average, 1 to 5)", "rp.n": "Ratings", "rp.care": "Care", "rp.comm": "Communication", "rp.daily": "Daily reports",
    "rp.prev_n": "Ratings last month", "rp.prev_care": "Care last month", "rp.prev_comm": "Communication last month", "rp.prev_daily": "Daily reports last month",
    "rp.chg_care": "Care change", "rp.chg_comm": "Communication change", "rp.chg_daily": "Daily reports change",
    "rp.compliments": "Compliments by staff member", "rp.staff": "Staff member", "rp.messages": "Messages",
  };
  var ar = {
    "s.nav.reports": "التقارير",
    "s.rp.title": "التقارير", "s.rp.privacy": "المدير والمالك فقط يستطيعان رؤية هذه الصفحة.",
    "s.rp.week": "هذا الأسبوع", "s.rp.month": "هذا الشهر", "s.rp.custom": "فترة مخصصة", "s.rp.from": "من", "s.rp.to": "إلى",
    "s.rp.show": "عرض", "s.rp.csv": "تنزيل ملف CSV", "s.rp.period": "الفترة", "s.rp.badperiod": "يُرجى اختيار فترة صحيحة، يسبق فيها تاريخ البداية تاريخ النهاية.",
    "s.rp.note": "تُحسب الطلبات حسب يوم وصولها. «في الموعد» تقارن وقت الاطلاع أو الحل بما وُعد به وليّ الأمر. «المتأخر الآن» و«المراجعات المفتوحة» تخص اللحظة الحالية. تعرض التقييمات الشهر الذي تنتهي فيه الفترة بجانب الشهر السابق.",
    "s.rp.none": "لا شيء في هذه الفترة.",
    "rp.summary": "الملخص", "rp.metric": "المؤشر", "rp.value": "القيمة", "rp.received": "الطلبات المستلمة", "rp.open_now": "المفتوحة الآن", "rp.overdue_now": "المتأخرة الآن",
    "rp.ack_on_time": "تم الاطلاع في الموعد", "rp.res_on_time": "تم الحل في الموعد", "rp.avg_resolve": "متوسط وقت الحل (بالساعات)",
    "rp.esc_cases": "الطلبات المصعّدة", "rp.esc_moves": "عدد التصعيدات", "rp.sat_yes": "رضا وليّ الأمر: نعم", "rp.sat_no": "رضا وليّ الأمر: لا",
    "rp.sat_waiting": "تم الحل وفي انتظار رد وليّ الأمر", "rp.acc_total": "الحوادث المسجلة", "rp.open_inv": "المراجعات المفتوحة",
    "rp.by_type_urgency": "الطلبات حسب النوع والاستعجال", "rp.type": "النوع", "rp.urgency": "الاستعجال", "rp.count": "العدد",
    "rp.type.complaint": "ملاحظة", "rp.type.safety_concern": "قلق بشأن السلامة", "rp.urg.critical": "حرج", "rp.urg.urgent": "عاجل", "rp.urg.can_wait": "يمكن الانتظار",
    "rp.esc_by_level": "التصعيدات حسب المستوى الذي وصلت إليه", "rp.level": "المستوى",
    "rp.acc_by_class": "الحوادث حسب الفصل", "rp.class": "الفصل", "rp.acc_by_location": "الحوادث حسب المكان", "rp.location": "المكان",
    "rp.acc_by_severity": "الحوادث حسب الخطورة", "rp.severity": "الخطورة", "rp.sev.minor": "بسيطة", "rp.sev.needs_attention": "تحتاج إلى متابعة", "rp.sev.serious": "خطيرة",
    "rp.ratings": "تقييمات أولياء الأمور حسب الفصل (المتوسط من ١ إلى ٥)", "rp.n": "عدد التقييمات", "rp.care": "الرعاية", "rp.comm": "التواصل", "rp.daily": "التقارير اليومية",
    "rp.prev_n": "تقييمات الشهر الماضي", "rp.prev_care": "الرعاية الشهر الماضي", "rp.prev_comm": "التواصل الشهر الماضي", "rp.prev_daily": "التقارير اليومية الشهر الماضي",
    "rp.chg_care": "تغيّر الرعاية", "rp.chg_comm": "تغيّر التواصل", "rp.chg_daily": "تغيّر التقارير اليومية",
    "rp.compliments": "الإشادات حسب الموظف", "rp.staff": "الموظف", "rp.messages": "الرسائل",
  };
  Object.assign(CKA.STR.en, en);
  Object.assign(CKA.STR.ar, ar);
})();
