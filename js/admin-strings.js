// Wording for the admin area (#/admin) and staff job titles, English and Arabic.
// Please have a native Arabic speaker review the Arabic before launch.
(function () {
  var en = {
    "s.nav.admin": "Admin", "role.finance": "Finance",
    "jt.teacher": "Teacher", "jt.co_teacher": "Co-teacher", "jt.assistant": "Assistant", "jt.admin": "Admin", "jt.manager": "Manager", "jt.owner": "Owner", "jt.finance_assistant": "Finance assistant", "jt.finance_manager": "Finance manager",
    "staff.jobtitle": "Job title", "staff.titlesaved": "Job title saved.",
    "ad.title": "Admin", "ad.tab.today": "Today", "ad.tab.children": "Children", "ad.tab.classes": "Classes", "ad.tab.settings": "Settings", "ad.tab.people": "Staff accounts",
    "ad.today.title": "Today at a glance", "ad.t.present": "Children present", "ad.t.absent": "Absent (told us)", "ad.t.notarrived": "Not arrived, no notice", "ad.t.reports": "Reports ready to send", "ad.t.sent": "Reports sent",
    "ad.t.unread": "Important announcements still unread", "ad.t.events": "Events waiting for answers", "ad.t.cases": "Open cases", "ad.t.overdue": "Cases overdue", "ad.t.critical": "Critical cases", "ad.t.apps": "New applications", "ad.t.children": "Children enrolled",
    "ad.ch.search": "Search by child or parent name", "ad.ch.all_classes": "All classes", "ad.ch.withdrawn": "Show withdrawn children", "ad.ch.none": "No children match.", "ad.ch.allergy": "Allergy", "ad.ch.noclass": "No class", "ad.ch.withdrawn_tag": "Withdrawn",
    "ad.pr.back": "← All children", "ad.pr.class": "Class", "ad.pr.move": "Move to another class", "ad.pr.move_btn": "Move", "ad.pr.moved": "Moved. The change was recorded.", "ad.pr.parents": "Parents and access", "ad.pr.pickups": "People who may collect the child",
    "ad.pr.health": "Health", "ad.pr.allergies": "Allergies", "ad.pr.conditions": "Medical conditions", "ad.pr.medications": "Medications", "ad.pr.doctor": "Doctor", "ad.pr.consents": "Consents", "ad.pr.documents": "Documents", "ad.pr.log": "Change history",
    "ad.pr.none": "None recorded", "ad.pr.id_photo": "ID photo saved", "ad.pr.open": "Open", "ad.pr.dob": "Date of birth", "ad.pr.since": "Enrolled since",
    "ad.access.active": "Signed in", "ad.access.invited": "Invited, not signed in yet", "ad.access.off": "Access off",
    "ad.c.photos_class": "Photos in class", "ad.c.photos_social": "Photos on social media", "ad.c.outings": "Outings", "ad.c.emergency_treatment": "Emergency treatment", "ad.c.birthday_wall": "Birthday wall", "ad.yes": "Yes", "ad.no": "No",
    "ad.log.created": "Created", "ad.log.health": "Health", "ad.log.pickup": "Pickup people", "ad.log.consent": "Consent", "ad.log.contact": "Contact", "ad.log.class": "Class", "ad.log.withdrawn": "Withdrawn", "ad.log.reinstated": "Re-enrolled",
    "ad.wd.title": "Withdraw this child", "ad.wd.hint": "The child is switched off but everything is kept. Parents who have no other child here lose access.", "ad.wd.reason": "Reason", "ad.wd.btn": "Withdraw", "ad.wd.confirm": "Withdraw this child?", "ad.wd.done": "Withdrawn.", "ad.wd.need": "Please write the reason.",
    "ad.re.title": "Re-enrol this child", "ad.re.btn": "Re-enrol", "ad.re.done": "Re-enrolled; the parents' access is back on.",
    "ad.cl.new": "New class", "ad.cl.name": "Class name", "ad.cl.age": "Age range (for example 1-2 years)", "ad.cl.cap": "Capacity", "ad.cl.save": "Save class", "ad.cl.edit": "Edit", "ad.cl.enrolled": "enrolled", "ad.cl.present": "here today", "ad.cl.of": "of",
    "ad.cl.head": "Head teacher", "ad.cl.staff": "Staff in this class", "ad.cl.none_staff": "No staff assigned yet.", "ad.cl.add_staff": "Add a staff member", "ad.cl.role": "Role in the class", "ad.cl.r.head": "Head teacher", "ad.cl.r.teacher": "Teacher", "ad.cl.r.co_teacher": "Co-teacher", "ad.cl.r.assistant": "Assistant",
    "ad.cl.remove": "Remove", "ad.cl.full": "Full", "ad.cl.schedule": "Daily schedule", "ad.cl.schedule_link": "Edit the daily schedule", "ad.cl.saved": "Saved.", "ad.cl.need": "Please give the class a name and an age range.", "ad.err": "That could not be saved.", "ad.cl.pick_staff": "Choose a person",
    "ad.set.title": "Academy details", "ad.set.phone": "Phone number", "ad.set.whatsapp": "WhatsApp number (digits with country code, for example 201063344389)", "ad.set.email": "Email address", "ad.set.addr_en": "Address (English)", "ad.set.addr_ar": "Address (Arabic)",
    "ad.set.close": "Closing time (pickups after this count as overtime)", "ad.set.save": "Save", "ad.set.saved": "Settings saved.",
    "ad.fixed.title": "Rules that are built in", "ad.fixed.hours": "Working days and hours: Sunday to Thursday, 8:00 am to 6:00 pm, Cairo time. Friday and Saturday are not working days.", "ad.fixed.urgency": "Urgency promises: Critical: acknowledge within 1 hour and call the parent; Urgent: acknowledge within 2 working hours, resolve within 24 hours; Can wait: acknowledge within 1 working day, resolve within 3 business days.",
    "ad.fixed.change": "These rules, the wording of consents and the text of the emails are fixed in the system. If you want them changed, ask the person who maintains the system.", "ad.fixed.links": "Set elsewhere:", "ad.fixed.reports": "When reports are sent: Daily reports", "ad.fixed.photos": "How long photos are kept: Photos",
  };
  var ar = {
    "s.nav.admin": "الإدارة", "role.finance": "المالية",
    "jt.teacher": "معلمة", "jt.co_teacher": "معلمة مساعدة", "jt.assistant": "مساعدة", "jt.admin": "إدارة", "jt.manager": "مدير", "jt.owner": "المالك", "jt.finance_assistant": "مساعد مالي", "jt.finance_manager": "مدير مالي",
    "staff.jobtitle": "المسمى الوظيفي", "staff.titlesaved": "تم حفظ المسمى الوظيفي.",
    "ad.title": "الإدارة", "ad.tab.today": "اليوم", "ad.tab.children": "الأطفال", "ad.tab.classes": "الفصول", "ad.tab.settings": "الإعدادات", "ad.tab.people": "حسابات الموظفين",
    "ad.today.title": "اليوم في لمحة", "ad.t.present": "الأطفال الحاضرون", "ad.t.absent": "غائبون (أخبرونا)", "ad.t.notarrived": "لم يصلوا بلا إشعار", "ad.t.reports": "تقارير جاهزة للإرسال", "ad.t.sent": "تقارير أُرسلت",
    "ad.t.unread": "إعلانات مهمة لم تُقرأ", "ad.t.events": "فعاليات تنتظر الردود", "ad.t.cases": "الطلبات المفتوحة", "ad.t.overdue": "طلبات متأخرة", "ad.t.critical": "طلبات حرجة", "ad.t.apps": "طلبات تسجيل جديدة", "ad.t.children": "الأطفال المسجلون",
    "ad.ch.search": "ابحث باسم الطفل أو وليّ الأمر", "ad.ch.all_classes": "كل الفصول", "ad.ch.withdrawn": "إظهار الأطفال المنسحبين", "ad.ch.none": "لا يوجد أطفال مطابقون.", "ad.ch.allergy": "حساسية", "ad.ch.noclass": "بلا فصل", "ad.ch.withdrawn_tag": "منسحب",
    "ad.pr.back": "← كل الأطفال", "ad.pr.class": "الفصل", "ad.pr.move": "نقل إلى فصل آخر", "ad.pr.move_btn": "نقل", "ad.pr.moved": "تم النقل. سُجّل التغيير.", "ad.pr.parents": "أولياء الأمور والدخول", "ad.pr.pickups": "من يحق له استلام الطفل",
    "ad.pr.health": "الصحة", "ad.pr.allergies": "الحساسية", "ad.pr.conditions": "الحالات الطبية", "ad.pr.medications": "الأدوية", "ad.pr.doctor": "الطبيب", "ad.pr.consents": "الموافقات", "ad.pr.documents": "المستندات", "ad.pr.log": "سجل التغييرات",
    "ad.pr.none": "لا شيء مسجل", "ad.pr.id_photo": "صورة الهوية محفوظة", "ad.pr.open": "فتح", "ad.pr.dob": "تاريخ الميلاد", "ad.pr.since": "مسجل منذ",
    "ad.access.active": "سجّل الدخول", "ad.access.invited": "مدعو ولم يسجل الدخول بعد", "ad.access.off": "الدخول موقوف",
    "ad.c.photos_class": "الصور في الفصل", "ad.c.photos_social": "الصور على وسائل التواصل", "ad.c.outings": "الرحلات", "ad.c.emergency_treatment": "العلاج الطارئ", "ad.c.birthday_wall": "لوحة أعياد الميلاد", "ad.yes": "نعم", "ad.no": "لا",
    "ad.log.created": "أُنشئ", "ad.log.health": "الصحة", "ad.log.pickup": "المخوّلون بالاستلام", "ad.log.consent": "موافقة", "ad.log.contact": "بيانات التواصل", "ad.log.class": "الفصل", "ad.log.withdrawn": "انسحاب", "ad.log.reinstated": "إعادة تسجيل",
    "ad.wd.title": "سحب هذا الطفل", "ad.wd.hint": "يتوقف الطفل مع الاحتفاظ بكل شيء. يفقد الدخول أولياء الأمور الذين ليس لديهم طفل آخر هنا.", "ad.wd.reason": "السبب", "ad.wd.btn": "سحب", "ad.wd.confirm": "هل تريد سحب هذا الطفل؟", "ad.wd.done": "تم السحب.", "ad.wd.need": "يُرجى كتابة السبب.",
    "ad.re.title": "إعادة تسجيل هذا الطفل", "ad.re.btn": "إعادة التسجيل", "ad.re.done": "أُعيد تسجيله وعاد دخول أولياء الأمور.",
    "ad.cl.new": "فصل جديد", "ad.cl.name": "اسم الفصل", "ad.cl.age": "الفئة العمرية (مثلاً من سنة إلى سنتين)", "ad.cl.cap": "السعة", "ad.cl.save": "حفظ الفصل", "ad.cl.edit": "تعديل", "ad.cl.enrolled": "مسجل", "ad.cl.present": "حاضر اليوم", "ad.cl.of": "من",
    "ad.cl.head": "المعلمة الرئيسية", "ad.cl.staff": "العاملون في هذا الفصل", "ad.cl.none_staff": "لم يُعيَّن أحد بعد.", "ad.cl.add_staff": "إضافة موظف", "ad.cl.role": "الدور في الفصل", "ad.cl.r.head": "المعلمة الرئيسية", "ad.cl.r.teacher": "معلمة", "ad.cl.r.co_teacher": "معلمة مساعدة", "ad.cl.r.assistant": "مساعدة",
    "ad.cl.remove": "إزالة", "ad.cl.full": "ممتلئ", "ad.cl.schedule": "الجدول اليومي", "ad.cl.schedule_link": "تعديل الجدول اليومي", "ad.cl.saved": "تم الحفظ.", "ad.cl.need": "يُرجى كتابة اسم الفصل والفئة العمرية.", "ad.err": "تعذّر الحفظ.", "ad.cl.pick_staff": "اختر شخصاً",
    "ad.set.title": "بيانات الحضانة", "ad.set.phone": "رقم الهاتف", "ad.set.whatsapp": "رقم واتساب (أرقام مع رمز الدولة، مثلاً 201063344389)", "ad.set.email": "البريد الإلكتروني", "ad.set.addr_en": "العنوان (إنجليزي)", "ad.set.addr_ar": "العنوان (عربي)",
    "ad.set.close": "وقت الإغلاق (الاستلام بعده يُحسب وقتاً إضافياً)", "ad.set.save": "حفظ", "ad.set.saved": "تم حفظ الإعدادات.",
    "ad.fixed.title": "قواعد مدمجة في النظام", "ad.fixed.hours": "أيام وساعات العمل: من الأحد إلى الخميس، من 8:00 صباحاً إلى 6:00 مساءً بتوقيت القاهرة. الجمعة والسبت ليستا يومَي عمل.", "ad.fixed.urgency": "مواعيد الأولوية: حرج: الرد خلال ساعة والاتصال بوليّ الأمر؛ عاجل: الرد خلال ساعتي عمل والحل خلال 24 ساعة؛ يمكن الانتظار: الرد خلال يوم عمل والحل خلال 3 أيام عمل.",
    "ad.fixed.change": "هذه القواعد وصياغة الموافقات ونصوص الرسائل ثابتة في النظام. إذا أردت تغييرها فاطلب ذلك ممن يتولى صيانة النظام.", "ad.fixed.links": "تُضبط في مكان آخر:", "ad.fixed.reports": "موعد إرسال التقارير: التقارير اليومية", "ad.fixed.photos": "مدة الاحتفاظ بالصور: الصور",
  };
  Object.assign(CKA.STR.en, en);
  Object.assign(CKA.STR.ar, ar);
})();
