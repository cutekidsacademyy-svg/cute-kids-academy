// /login: sign in, "forgot password", and "choose your password" (invitation and reset links).
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var msg = $("msg");
  var forms = { signin: $("signinForm"), forgot: $("forgotForm"), set: $("setForm") };

  function show(which) {
    Object.keys(forms).forEach(function (k) { forms[k].classList.toggle("hidden", k !== which); });
  }
  function say(kind, key) {
    msg.className = "note " + kind;
    msg.textContent = CKA.t(key);
    msg.dataset.key = key;
  }
  function clear() { msg.className = "note hidden"; msg.textContent = ""; delete msg.dataset.key; }
  document.addEventListener("cka-lang", function () { if (msg.dataset.key) msg.textContent = CKA.t(msg.dataset.key); });

  function busy(form, on) { form.querySelectorAll("button[type=submit]").forEach(function (b) { b.disabled = on; }); }

  function goHome(profile) { location.replace(CKA.homePath(profile.role)); }

  async function afterSignIn() {
    var res = await CKA.getProfile();
    if (!res.session) throw new Error("no session");
    if (!res.profile || !res.profile.active) {
      await CKA.client.auth.signOut();
      say("err", "login.inactive");
      show("signin");
      return;
    }
    CKA.touch();
    goHome(res.profile);
  }

  // Is this page being opened from an invitation or password-reset email link?
  function fromEmailLink() {
    var h = location.hash || "", q = location.search || "";
    return /type=(invite|recovery)/.test(h) || /mode=set-password/.test(q) || /error_code=/.test(h);
  }

  async function init() {
    if (!CKA.configured) { say("info", "login.off"); return; }
    var params = new URLSearchParams(location.search);

    if (fromEmailLink()) {
      show("set");
      if (/error_code=|error=/.test(location.hash)) { say("err", "login.set.invalid"); show("forgot"); return; }
      say("info", "login.set.wait");
      // supabase-js reads the link's token from the address bar and creates a session.
      var tries = 0;
      var timer = setInterval(async function () {
        tries++;
        var s = await CKA.client.auth.getSession();
        if (s.data.session) { clearInterval(timer); clear(); $("newPassword").focus(); }
        else if (tries > 20) { clearInterval(timer); say("err", "login.set.invalid"); show("forgot"); }
      }, 300);
      return;
    }

    var existing = await CKA.getProfile();
    if (existing.session && existing.profile && existing.profile.active) { goHome(existing.profile); return; }
    if (params.get("reason") === "timeout") say("info", "login.timeout");
    else if (params.get("reason") === "inactive") say("err", "login.inactive");
    show("signin");
  }

  forms.signin.addEventListener("submit", async function (e) {
    e.preventDefault(); clear(); busy(forms.signin, true);
    try {
      var r = await CKA.client.auth.signInWithPassword({ email: $("email").value.trim(), password: $("password").value });
      if (r.error) { say("err", "login.bad"); return; }
      await afterSignIn();
    } catch (err) { say("err", "login.error"); }
    finally { busy(forms.signin, false); }
  });

  forms.forgot.addEventListener("submit", async function (e) {
    e.preventDefault(); clear(); busy(forms.forgot, true);
    try {
      await CKA.client.auth.resetPasswordForEmail($("forgotEmail").value.trim(), {
        redirectTo: location.origin + "/login/?mode=set-password",
      });
    } catch (err) { /* same message either way, so nobody can probe which emails have accounts */ }
    say("ok", "login.forgot.sent");
    busy(forms.forgot, false);
  });

  forms.set.addEventListener("submit", async function (e) {
    e.preventDefault(); clear();
    var p1 = $("newPassword").value, p2 = $("newPassword2").value;
    if (p1.length < 8) { say("err", "login.set.short"); return; }
    if (p1 !== p2) { say("err", "login.set.mismatch"); return; }
    busy(forms.set, true);
    try {
      var r = await CKA.client.auth.updateUser({ password: p1 });
      if (r.error) { say("err", "login.set.invalid"); return; }
      history.replaceState(null, "", "/login/");
      await afterSignIn();
    } catch (err) { say("err", "login.error"); }
    finally { busy(forms.set, false); }
  });

  $("toForgot").addEventListener("click", function () { clear(); show("forgot"); $("forgotEmail").value = $("email").value; });
  $("toSignin").addEventListener("click", function () { clear(); show("signin"); });

  document.addEventListener("DOMContentLoaded", init);
})();
