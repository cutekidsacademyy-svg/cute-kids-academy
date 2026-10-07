// Wording for Birthdays and Transport (staff screens, parent page), English and Arabic. Please have a native Arabic speaker review it.
(function () {
  var en = {
    "s.nav.birthdays": "Birthdays", "s.nav.transport": "Transport", "p.nav.transport": "Transport", "mo.transport": "School bus",
    "bd.title": "Birthdays", "bd.hint": "At 8:00 on the day, both parents get a birthday message from the academy.", "bd.auto": "Send the birthday message automatically", "bd.msg_en": "Message (English)", "bd.msg_ar": "Message (Arabic)",
    "bd.placeholder": "Write {child} where the child's first name should go.", "bd.save": "Save", "bd.saved": "Saved.", "bd.by_month": "Birthdays by month", "bd.none": "No birthdays this month.", "bd.turning": "turning", "bd.on_wall": "On the birthday wall",
    "bd.send_now": "Send now", "bd.confirm": "Send the birthday message to both parents now?", "bd.sent": "The message was sent.", "bd.sent_this_year": "sent this year",
    "bd.wall": "Public birthday wall", "bd.wall_hint": "Shows only a first name, an initial and the age, and only for children whose parents agreed when registering. A parent can withdraw this at any time.", "bd.wall_open": "Open the birthday wall",
    "tr.title": "Transport", "tr.none": "No bus routes yet.", "tr.inactive": "Not running", "tr.open_run": "Open today's run", "tr.edit": "Edit", "tr.new": "New route", "tr.save": "Save the route", "tr.saved": "Route saved.", "tr.back": "← All routes",
    "tr.f.name": "Route name", "tr.f.driver": "Driver", "tr.f.phone": "Driver's phone", "tr.f.rider": "Staff member who rides the bus", "tr.rider_none": "(nobody)", "tr.f.rider_name": "Or write the name", "tr.f.fee": "Monthly fee for each child (EGP, 0 for free)", "tr.f.active": "The route is running",
    "tr.stops": "Stops", "tr.stop_name": "Stop name", "tr.add_stop": "Add the stop", "tr.stop_need": "Please write the stop name.", "tr.morning": "Morning", "tr.afternoon": "Afternoon", "tr.remove": "Remove",
    "tr.children": "Children on this route", "tr.no_stop": "(no stop yet)", "tr.add_child": "Add a child…", "tr.one_route": "A child can be on one route only.",
    "tr.st.on_board": "On board", "tr.st.absent": "Absent", "tr.st.dropped_off": "Dropped off", "tr.near": "Bus is 10 minutes away", "tr.near_sent": "The families were told ({n}).", "tr.no_children": "No children at this stop.", "tr.unassigned": "Children without a stop",
    "pt.title": "School bus", "pt.none": "Your child is not on a bus route.", "pt.route": "Route", "pt.driver": "Driver", "pt.stop": "Stop", "pt.morning": "Morning pick-up", "pt.afternoon": "Afternoon drop-off", "pt.today": "Today",
    "pt.st.on_board": "On board", "pt.st.absent": "Not riding today", "pt.st.dropped_off": "Dropped off", "pt.st.none": "Not yet",
  };
  var ar = {
    "s.nav.birthdays": "أعياد الميلاد", "s.nav.transport": "المواصلات", "p.nav.transport": "المواصلات", "mo.transport": "أتوبيس الحضانة",
    "bd.title": "أعياد الميلاد", "bd.hint": "في الساعة 8:00 من يوم الميلاد يصل كلا الوالدين رسالة تهنئة من الحضانة.", "bd.auto": "إرسال رسالة التهنئة تلقائياً", "bd.msg_en": "الرسالة (إنجليزي)", "bd.msg_ar": "الرسالة (عربي)",
    "bd.placeholder": "اكتب {child} في المكان الذي يظهر فيه الاسم الأول للطفل.", "bd.save": "حفظ", "bd.saved": "تم الحفظ.", "bd.by_month": "أعياد الميلاد حسب الشهر", "bd.none": "لا أعياد ميلاد هذا الشهر.", "bd.turning": "يبلغ", "bd.on_wall": "على لوحة أعياد الميلاد",
    "bd.send_now": "إرسال الآن", "bd.confirm": "هل ترسل رسالة التهنئة إلى الوالدين الآن؟", "bd.sent": "تم إرسال الرسالة.", "bd.sent_this_year": "أُرسلت هذا العام",
    "bd.wall": "لوحة أعياد الميلاد العامة", "bd.wall_hint": "تعرض الاسم الأول وحرفاً من الاسم والعمر فقط، ولا تعرض إلا الأطفال الذين وافق أولياء أمورهم عند التسجيل. يمكن لوليّ الأمر سحب الموافقة في أي وقت.", "bd.wall_open": "فتح لوحة أعياد الميلاد",
    "tr.title": "المواصلات", "tr.none": "لا توجد خطوط أتوبيس بعد.", "tr.inactive": "متوقف", "tr.open_run": "فتح رحلة اليوم", "tr.edit": "تعديل", "tr.new": "خط جديد", "tr.save": "حفظ الخط", "tr.saved": "تم حفظ الخط.", "tr.back": "← كل الخطوط",
    "tr.f.name": "اسم الخط", "tr.f.driver": "السائق", "tr.f.phone": "هاتف السائق", "tr.f.rider": "الموظفة أو الموظف المرافق في الأتوبيس", "tr.rider_none": "(لا أحد)", "tr.f.rider_name": "أو اكتب الاسم", "tr.f.fee": "الرسوم الشهرية لكل طفل (جنيه، صفر إذا كان مجانياً)", "tr.f.active": "الخط يعمل",
    "tr.stops": "المحطات", "tr.stop_name": "اسم المحطة", "tr.add_stop": "إضافة المحطة", "tr.stop_need": "يُرجى كتابة اسم المحطة.", "tr.morning": "الصباح", "tr.afternoon": "بعد الظهر", "tr.remove": "حذف",
    "tr.children": "الأطفال على هذا الخط", "tr.no_stop": "(بلا محطة بعد)", "tr.add_child": "إضافة طفل…", "tr.one_route": "يمكن أن يكون الطفل على خط واحد فقط.",
    "tr.st.on_board": "في الأتوبيس", "tr.st.absent": "غائب", "tr.st.dropped_off": "تم إنزاله", "tr.near": "الأتوبيس على بعد 10 دقائق", "tr.near_sent": "تم إبلاغ الأسر ({n}).", "tr.no_children": "لا أطفال في هذه المحطة.", "tr.unassigned": "أطفال بلا محطة",
    "pt.title": "أتوبيس الحضانة", "pt.none": "طفلك ليس على خط أتوبيس.", "pt.route": "الخط", "pt.driver": "السائق", "pt.stop": "المحطة", "pt.morning": "الاستلام صباحاً", "pt.afternoon": "التوصيل بعد الظهر", "pt.today": "اليوم",
    "pt.st.on_board": "في الأتوبيس", "pt.st.absent": "لا يركب اليوم", "pt.st.dropped_off": "تم إنزاله", "pt.st.none": "لم يبدأ بعد",
  };
  Object.assign(CKA.STR.en, en);
  Object.assign(CKA.STR.ar, ar);
})();
