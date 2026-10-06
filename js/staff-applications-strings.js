// Wording for the staff Applications screens and the teacher's "My class" page, English and Arabic.
// Please have a native Arabic speaker review the Arabic before launch.
(function () {
  var en = {
    "s.nav.applications": "Applications", "s.nav.class": "My class",
    "ap.title": "Applications", "ap.intro": "Families who filled in the online registration form. Open one to read it, ask for missing papers, book a tour, or approve it.",
    "ap.f.open": "Open", "ap.f.all": "All", "ap.none": "No applications here.",
    "ap.st.new": "New", "ap.st.missing_documents": "Missing information", "ap.st.tour_booked": "Tour booked", "ap.st.waitlist": "Waiting list", "ap.st.approved": "Approved", "ap.st.declined": "Declined",
    "ap.no": "Application", "ap.parent": "Parent", "ap.submitted": "Sent", "ap.birth": "Birth certificate", "ap.vacc": "Vaccination record", "ap.have": "received", "ap.lack": "not received",
    "ap.back": "← All applications", "ap.child": "Child", "ap.dob": "Date of birth", "ap.programme": "Programme", "ap.start": "Preferred start", "ap.lang": "Language for emails", "ap.class": "Class",
    "ap.prog.nursery": "Nursery", "ap.prog.preschool": "Preschool", "ap.prog.after_school": "After-school", "ap.prog.camp": "Camp",
    "ap.rel.mother": "Mother", "ap.rel.father": "Father", "ap.rel.guardian": "Guardian", "ap.rel.other": "Other",
    "ap.parents": "Parents", "ap.health": "Health", "ap.allergies": "Allergies", "ap.conditions": "Medical conditions", "ap.medications": "Medications", "ap.doctor": "Doctor",
    "ap.pickups": "People who may collect the child", "ap.no_pickups": "None given", "ap.consents": "Consents", "ap.documents": "Documents", "ap.no_docs": "No documents uploaded", "ap.open_file": "Open", "ap.id_photo": "ID photo",
    "ap.c.photos_class": "Photos in class", "ap.c.photos_social": "Photos on social media", "ap.c.outings": "Outings", "ap.c.emergency_treatment": "Emergency treatment", "ap.c.birthday_wall": "Birthday wall on the website",
    "ap.yes": "Yes", "ap.no_": "No", "ap.history": "History",
    "ap.ev.submitted": "Application received", "ap.ev.new": "Marked as new", "ap.ev.missing_documents": "Asked for more information", "ap.ev.tour_booked": "Tour booked", "ap.ev.waitlist": "Put on the waiting list", "ap.ev.declined": "Declined", "ap.ev.approved": "Approved",
    "ap.change": "Change the status", "ap.new_status": "New status", "ap.note": "Message for the family", "ap.note_hint": "Required for \"Missing information\" and \"Declined\". The family gets an email with this text.",
    "ap.save_status": "Save status", "ap.saved": "Saved. The family has been emailed.", "ap.saved_quiet": "Saved.", "ap.need_note": "Please write what is missing, or the reason.",
    "ap.approve": "Approve", "ap.approve_hint": "Creates the child's record in the chosen class and invites the parents to the portal.", "ap.choose_class": "Choose a class", "ap.need_class": "Please choose a class.",
    "ap.approve_btn": "Approve and invite parents", "ap.confirm": "Approve this application and send the invitations?", "ap.working": "Working…",
    "ap.results": "Invitations", "ap.out.invited": "Invitation sent", "ap.out.linked": "Already has a login: linked to the child", "ap.out.failed": "Could not be invited",
    "ap.retry": "Try the invitations again", "ap.retry_hint": "If an invitation did not go out, try again here.", "ap.approved_done": "Approved. The child is now in the class.", "ap.class_empty": "No classes exist yet. Add a class first.",
    "mc.title": "My class", "mc.intro": "Allergies of the children in your class, so you always have them to hand. Only you and the academy's management can see these.",
    "mc.none": "No allergies recorded", "mc.empty": "There are no children in your class yet.", "mc.recorded": "Allergies", "mc.count": "children",
  };
  var ar = {
    "s.nav.applications": "طلبات التسجيل", "s.nav.class": "فصلي",
    "ap.title": "طلبات التسجيل", "ap.intro": "الأسر التي ملأت نموذج التسجيل عبر الإنترنت. افتح أي طلب لقراءته أو طلب أوراق ناقصة أو ترتيب زيارة أو قبوله.",
    "ap.f.open": "المفتوحة", "ap.f.all": "الكل", "ap.none": "لا توجد طلبات هنا.",
    "ap.st.new": "جديد", "ap.st.missing_documents": "معلومات ناقصة", "ap.st.tour_booked": "تم حجز زيارة", "ap.st.waitlist": "قائمة الانتظار", "ap.st.approved": "مقبول", "ap.st.declined": "مرفوض",
    "ap.no": "الطلب", "ap.parent": "وليّ الأمر", "ap.submitted": "أُرسل", "ap.birth": "شهادة الميلاد", "ap.vacc": "سجل التطعيمات", "ap.have": "مستلم", "ap.lack": "غير مستلم",
    "ap.back": "← كل الطلبات", "ap.child": "الطفل", "ap.dob": "تاريخ الميلاد", "ap.programme": "البرنامج", "ap.start": "تاريخ البدء المفضل", "ap.lang": "لغة الرسائل", "ap.class": "الفصل",
    "ap.prog.nursery": "الحضانة", "ap.prog.preschool": "ما قبل المدرسة", "ap.prog.after_school": "ما بعد المدرسة", "ap.prog.camp": "المعسكر",
    "ap.rel.mother": "الأم", "ap.rel.father": "الأب", "ap.rel.guardian": "وصيّ", "ap.rel.other": "أخرى",
    "ap.parents": "أولياء الأمور", "ap.health": "الصحة", "ap.allergies": "الحساسية", "ap.conditions": "الحالات الطبية", "ap.medications": "الأدوية", "ap.doctor": "الطبيب",
    "ap.pickups": "من يحق له استلام الطفل", "ap.no_pickups": "لم يُذكر أحد", "ap.consents": "الموافقات", "ap.documents": "المستندات", "ap.no_docs": "لم تُرفع مستندات", "ap.open_file": "فتح", "ap.id_photo": "صورة الهوية",
    "ap.c.photos_class": "صور في الفصل", "ap.c.photos_social": "صور على وسائل التواصل", "ap.c.outings": "الرحلات", "ap.c.emergency_treatment": "العلاج الطارئ", "ap.c.birthday_wall": "لوحة أعياد الميلاد في الموقع",
    "ap.yes": "نعم", "ap.no_": "لا", "ap.history": "السجل",
    "ap.ev.submitted": "تم استلام الطلب", "ap.ev.new": "تم تحديده كجديد", "ap.ev.missing_documents": "طُلبت معلومات إضافية", "ap.ev.tour_booked": "تم حجز زيارة", "ap.ev.waitlist": "أُضيف إلى قائمة الانتظار", "ap.ev.declined": "تم الرفض", "ap.ev.approved": "تم القبول",
    "ap.change": "تغيير الحالة", "ap.new_status": "الحالة الجديدة", "ap.note": "رسالة إلى الأسرة", "ap.note_hint": "مطلوبة عند «معلومات ناقصة» و«مرفوض». ستصل الأسرة رسالة بريد إلكتروني بهذا النص.",
    "ap.save_status": "حفظ الحالة", "ap.saved": "تم الحفظ. أُرسلت رسالة إلى الأسرة.", "ap.saved_quiet": "تم الحفظ.", "ap.need_note": "يُرجى كتابة ما هو ناقص أو سبب الرفض.",
    "ap.approve": "قبول الطلب", "ap.approve_hint": "ينشئ سجل الطفل في الفصل المختار ويدعو أولياء الأمور إلى البوابة.", "ap.choose_class": "اختر فصلاً", "ap.need_class": "يُرجى اختيار فصل.",
    "ap.approve_btn": "قبول ودعوة أولياء الأمور", "ap.confirm": "هل تريد قبول هذا الطلب وإرسال الدعوات؟", "ap.working": "جارٍ التنفيذ…",
    "ap.results": "الدعوات", "ap.out.invited": "أُرسلت الدعوة", "ap.out.linked": "لديه حساب بالفعل: تم ربطه بالطفل", "ap.out.failed": "تعذّرت دعوته",
    "ap.retry": "إعادة محاولة الدعوات", "ap.retry_hint": "إذا لم تُرسل إحدى الدعوات فحاول مرة أخرى من هنا.", "ap.approved_done": "تم القبول. الطفل الآن في الفصل.", "ap.class_empty": "لا توجد فصول بعد. أضف فصلاً أولاً.",
    "mc.title": "فصلي", "mc.intro": "حساسية الأطفال في فصلك لتكون دائماً أمامك. لا يراها سواك وإدارة الحضانة.",
    "mc.none": "لا توجد حساسية مسجلة", "mc.empty": "لا يوجد أطفال في فصلك بعد.", "mc.recorded": "الحساسية", "mc.count": "أطفال",
  };
  Object.assign(CKA.STR.en, en);
  Object.assign(CKA.STR.ar, ar);
})();
