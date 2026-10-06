// Shared browser code for /login, /portal and /staff: Supabase client, language (English /
// Arabic with right-to-left), page guard and inactivity sign-out.
// Pages in /portal and /staff are only a shell: all data comes from Supabase, which checks
// every request against the privacy rules, so a visitor who skips this script still sees nothing.
(function () {
  "use strict";
  var cfg = window.CKA_PORTAL || {};
  var L = window.CKALogic;
  var LANG_KEY = "cka_portal_lang";
  var ACTIVE_KEY = "cka_last_active";

  var STR = {
    en: {
      brand: "Cute Kids Academy",
      "nav.site": "Back to website", "nav.signout": "Sign out", "nav.lang": "العربية",
      "login.title": "Parent & staff login", "login.welcome": "Welcome back",
      "login.sub": "Sign in to see your child's updates.",
      "field.email": "Email", "field.password": "Password", "field.newpassword": "New password",
      "field.confirm": "Type it again", "field.name": "Full name", "field.phone": "Phone (optional)",
      "field.language": "Language", "field.role": "Role", "field.children": "Child or children",
      "field.classes": "Classes (optional)",
      "btn.signin": "Sign in", "btn.forgot": "Forgot your password?", "btn.sendlink": "Send me a reset link",
      "btn.back": "Back to sign in", "btn.setpassword": "Save password",
      "login.noaccount": "Accounts are created by the academy. If you are a parent and do not have an invitation yet, please ask the nursery office.",
      "login.forgot.title": "Reset your password",
      "login.forgot.sent": "If that email has an account, we have sent a link to reset the password.",
      "login.set.title": "Choose your password", "login.set.sub": "Pick a password you will remember, at least 8 characters.",
      "login.set.mismatch": "The two passwords do not match.", "login.set.short": "Please use at least 8 characters.",
      "login.set.wait": "Checking your link…",
      "login.set.invalid": "This link has expired or was already used. Use “Forgot your password?” to get a new one, or ask the nursery office to invite you again.",
      "login.bad": "That email and password do not match. Please try again.",
      "login.inactive": "This account is not active. Please contact the nursery office.",
      "login.timeout": "You were signed out after a period of inactivity. Please sign in again.",
      "login.off": "The parent portal is not switched on yet. Please check back soon.",
      "login.error": "Something went wrong. Please try again.",
      "portal.hello": "Hello", "portal.children": "Your children", "portal.nochildren": "No children are linked to your account yet. Please contact the nursery office.",
      "portal.class": "Class", "portal.soon": "Your cases, accident reports and monthly rating will appear here soon.",
      "staff.title": "Staff area", "staff.today": "Today", "staff.soon": "The case queue, accident log and reports are coming next.",
      "staff.people": "People", "staff.inviteparent": "Invite a parent", "staff.invitestaff": "Add a staff member",
      "staff.sendinvite": "Send invitation", "staff.invited": "Invitation sent. They will get an email to set a password.",
      "staff.list": "Accounts", "staff.switchoff": "Switch off", "staff.switchon": "Switch on", "staff.off": "Switched off",
      "staff.confirmoff": "Switch off access for this person? They will not be able to log in. Their history is kept.",
      "staff.confirmon": "Switch access back on for this person?", "staff.changed": "Saved.",
      "staff.nochildren": "No children have been added yet.", "staff.working": "Working…",
      "staff.pickchild": "Choose at least one child.", "staff.you": "(you)",
      "role.parent": "Parent", "role.teacher": "Teacher", "role.admin": "Admin", "role.manager": "Manager", "role.owner": "Owner",
      "lang.ar": "Arabic", "lang.en": "English",
    },
    ar: {
      brand: "كيوت كيدز أكاديمي",
      "nav.site": "العودة إلى الموقع", "nav.signout": "تسجيل الخروج", "nav.lang": "English",
      "login.title": "تسجيل دخول أولياء الأمور والموظفين", "login.welcome": "أهلاً بعودتك",
      "login.sub": "سجّل الدخول لمتابعة أخبار طفلك.",
      "field.email": "البريد الإلكتروني", "field.password": "كلمة المرور", "field.newpassword": "كلمة المرور الجديدة",
      "field.confirm": "أعد كتابتها", "field.name": "الاسم بالكامل", "field.phone": "رقم الهاتف (اختياري)",
      "field.language": "اللغة", "field.role": "الوظيفة", "field.children": "الطفل أو الأطفال",
      "field.classes": "الفصول (اختياري)",
      "btn.signin": "تسجيل الدخول", "btn.forgot": "هل نسيت كلمة المرور؟", "btn.sendlink": "أرسل لي رابط إعادة التعيين",
      "btn.back": "العودة إلى تسجيل الدخول", "btn.setpassword": "حفظ كلمة المرور",
      "login.noaccount": "الحسابات تُنشأ من قِبل الحضانة. إذا كنت وليّ أمر ولم تصلك دعوة بعد، يُرجى التواصل مع مكتب الحضانة.",
      "login.forgot.title": "إعادة تعيين كلمة المرور",
      "login.forgot.sent": "إذا كان هذا البريد مسجّلاً لدينا، فقد أرسلنا إليه رابطاً لإعادة تعيين كلمة المرور.",
      "login.set.title": "اختر كلمة المرور", "login.set.sub": "اختر كلمة مرور تتذكرها، ٨ أحرف على الأقل.",
      "login.set.mismatch": "كلمتا المرور غير متطابقتين.", "login.set.short": "يُرجى استخدام ٨ أحرف على الأقل.",
      "login.set.wait": "جارٍ التحقق من الرابط…",
      "login.set.invalid": "انتهت صلاحية هذا الرابط أو سبق استخدامه. اختر «هل نسيت كلمة المرور؟» للحصول على رابط جديد، أو اطلب من مكتب الحضانة إرسال دعوة جديدة.",
      "login.bad": "البريد الإلكتروني وكلمة المرور غير متطابقين. حاول مرة أخرى.",
      "login.inactive": "هذا الحساب غير مفعّل. يُرجى التواصل مع مكتب الحضانة.",
      "login.timeout": "تم تسجيل خروجك بسبب عدم النشاط لفترة. يُرجى تسجيل الدخول مرة أخرى.",
      "login.off": "بوابة أولياء الأمور لم تُفعَّل بعد. يُرجى المحاولة لاحقاً.",
      "login.error": "حدث خطأ ما. يُرجى المحاولة مرة أخرى.",
      "portal.hello": "أهلاً", "portal.children": "أطفالك", "portal.nochildren": "لا يوجد أطفال مرتبطون بحسابك بعد. يُرجى التواصل مع مكتب الحضانة.",
      "portal.class": "الفصل", "portal.soon": "ستظهر هنا قريباً طلباتك وتقارير الحوادث والتقييم الشهري.",
      "staff.title": "منطقة الموظفين", "staff.today": "اليوم", "staff.soon": "قائمة الطلبات وسجل الحوادث والتقارير قادمة قريباً.",
      "staff.people": "الأشخاص", "staff.inviteparent": "دعوة وليّ أمر", "staff.invitestaff": "إضافة موظف",
      "staff.sendinvite": "إرسال الدعوة", "staff.invited": "تم إرسال الدعوة. سيصلهم بريد لاختيار كلمة المرور.",
      "staff.list": "الحسابات", "staff.switchoff": "إيقاف", "staff.switchon": "تفعيل", "staff.off": "موقوف",
      "staff.confirmoff": "إيقاف الدخول لهذا الشخص؟ لن يتمكن من تسجيل الدخول، وسيبقى سجله محفوظاً.",
      "staff.confirmon": "إعادة تفعيل الدخول لهذا الشخص؟", "staff.changed": "تم الحفظ.",
      "staff.nochildren": "لم تتم إضافة أطفال بعد.", "staff.working": "جارٍ التنفيذ…",
      "staff.pickchild": "اختر طفلاً واحداً على الأقل.", "staff.you": "(أنت)",
      "role.parent": "وليّ أمر", "role.teacher": "معلّم", "role.admin": "إدارة", "role.manager": "مدير الحضانة", "role.owner": "المالك",
      "lang.ar": "العربية", "lang.en": "English",
    },
  };

  function getLang() {
    var saved = null;
    try { saved = localStorage.getItem(LANG_KEY); } catch (e) {}
    if (saved === "ar" || saved === "en") return saved;
    return (navigator.language || "").toLowerCase().indexOf("ar") === 0 ? "ar" : "en";
  }
  function t(key) { var l = STR[getLang()]; return (l && l[key]) || STR.en[key] || key; }
  function applyI18n(root) {
    var lang = getLang();
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === "ar" ? "rtl" : "ltr";
    (root || document).querySelectorAll("[data-i18n]").forEach(function (n) { n.textContent = t(n.getAttribute("data-i18n")); });
    (root || document).querySelectorAll("[data-i18n-placeholder]").forEach(function (n) { n.setAttribute("placeholder", t(n.getAttribute("data-i18n-placeholder"))); });
  }
  function setLang(lang) {
    try { localStorage.setItem(LANG_KEY, lang); } catch (e) {}
    applyI18n();
    document.dispatchEvent(new CustomEvent("cka-lang"));
  }

  var client = null;
  var configured = !!(cfg.supabaseUrl && cfg.supabaseAnonKey && window.supabase);
  if (configured) {
    client = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    });
  }

  function touch() { try { localStorage.setItem(ACTIVE_KEY, String(Date.now())); } catch (e) {} }
  function lastActive() { try { var v = localStorage.getItem(ACTIVE_KEY); return v ? Number(v) : null; } catch (e) { return null; } }

  async function signOut(reason) {
    try { if (client) await client.auth.signOut(); } catch (e) {}
    try { localStorage.removeItem(ACTIVE_KEY); } catch (e) {}
    location.replace("/login/" + (reason ? "?reason=" + reason : ""));
  }

  // Sign out after 30 minutes without a click, key press, tap or scroll (this tab or any other).
  function watchInactivity() {
    if (L.isExpired(lastActive(), Date.now())) { signOut("timeout"); return; }
    touch();
    var last = 0;
    ["click", "keydown", "touchstart", "scroll", "mousemove"].forEach(function (ev) {
      window.addEventListener(ev, function () { var n = Date.now(); if (n - last > 15000) { last = n; touch(); } }, { passive: true });
    });
    setInterval(function () { if (L.isExpired(lastActive(), Date.now())) signOut("timeout"); }, 30000);
  }

  async function getProfile() {
    var s = await client.auth.getSession();
    if (!s.data.session) return { session: null, profile: null };
    var uid = s.data.session.user.id;
    // Row-level security returns this row only for an active account.
    var p = await client.from("profiles").select("id, full_name, role, active, language, phone").eq("id", uid).maybeSingle();
    return { session: s.data.session, profile: p.data || null };
  }

  // Call at the top of /portal and /staff pages. Resolves with { session, profile } when the
  // visitor belongs here; otherwise redirects and never resolves.
  async function requireArea(area) {
    if (!configured) { location.replace("/login/"); return new Promise(function () {}); }
    var res = await getProfile();
    var decision = res.session ? L.guard(area, res.profile) : { action: "login" };
    if (decision.action === "stay") { watchInactivity(); return res; }
    if (decision.action === "redirect") { location.replace(decision.to); return new Promise(function () {}); }
    if (res.session) await client.auth.signOut();
    location.replace("/login/" + (res.session ? "?reason=inactive" : ""));
    return new Promise(function () {});
  }

  // Tiny DOM helper: builds elements with textContent only (never innerHTML), so names that
  // families or staff type can never run as code.
  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === "class") n.className = attrs[k];
      else if (k === "text") n.textContent = attrs[k];
      else if (k.slice(0, 2) === "on") n.addEventListener(k.slice(2), attrs[k]);
      else n.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (c) { if (c) n.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return n;
  }

  window.CKA = {
    configured: configured, client: client, t: t, getLang: getLang, setLang: setLang, applyI18n: applyI18n,
    getProfile: getProfile, requireArea: requireArea, signOut: signOut, touch: touch, el: el,
    homePath: L.homePath, STR: STR,
  };

  document.addEventListener("DOMContentLoaded", function () {
    applyI18n();
    document.querySelectorAll("[data-lang-toggle]").forEach(function (b) {
      b.addEventListener("click", function () { setLang(getLang() === "ar" ? "en" : "ar"); });
    });
    document.querySelectorAll("[data-signout]").forEach(function (b) {
      b.addEventListener("click", function () { signOut(); });
    });
  });
})();
