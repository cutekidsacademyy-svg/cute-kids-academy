const CONTENT_BASE = "/content/";

const state = {
  settings: {},
  programs: [],
  ageGroups: [],
  team: [],
  events: [],
  testimonials: [],
  gallery: []
};

async function fetchJSON(path) {
  const res = await fetch(path, { cache: "no-store" });
  if (!res.ok) throw new Error("Failed to load " + path);
  return res.json();
}

async function loadContent() {
  const [settings, programs, ageGroups, team, events, testimonials, gallery] = await Promise.all([
    fetchJSON(CONTENT_BASE + "settings.json"),
    fetchJSON(CONTENT_BASE + "programs.json"),
    fetchJSON(CONTENT_BASE + "age-groups.json"),
    fetchJSON(CONTENT_BASE + "team.json"),
    fetchJSON(CONTENT_BASE + "events.json"),
    fetchJSON(CONTENT_BASE + "testimonials.json"),
    fetchJSON(CONTENT_BASE + "gallery.json")
  ]);
  state.settings = settings;
  state.programs = programs.items || [];
  state.ageGroups = ageGroups.items || [];
  state.team = team.items || [];
  state.events = events.items || [];
  state.testimonials = testimonials.items || [];
  state.gallery = gallery.items || [];
}

function whatsappLink(phone) {
  const digits = String(phone || "").replace(/\D/g, "").replace(/^0/, "");
  return `https://wa.me/20${digits}`;
}

function escapeHTML(str) {
  return String(str ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

/* ================= RENDER: TEXT / SETTINGS ================= */
function renderSettings() {
  const s = state.settings;
  document.getElementById("heroEyebrow").textContent = `Ages ${s.ages || ""}`;
  document.getElementById("heroHeading").textContent = s.heroHeading || "";
  document.getElementById("heroSubheading").textContent = s.heroSubheading || "";
  document.getElementById("missionHeading").textContent = s.missionHeading || "";
  document.getElementById("missionText").textContent = s.missionText || "";
  document.getElementById("missionPoints").innerHTML = (s.missionPoints || [])
    .map(pt => `<div class="point"><div class="dot">${escapeHTML(pt.icon || "🙂")}</div><div><h4>${escapeHTML(pt.title)}</h4><p>${escapeHTML(pt.text)}</p></div></div>`)
    .join("");

  document.getElementById("statPrograms").textContent = state.programs.length;
  document.getElementById("statAges").textContent = s.ages || "";
  const yearsServing = new Date().getFullYear() - Number(s.establishedYear || new Date().getFullYear());
  document.getElementById("statEstablished").textContent = yearsServing;
  document.getElementById("statEstablishedLabel").textContent = s.statEstablishedLabel || "";
  document.getElementById("statDifferentiator").textContent = s.statDifferentiatorValue || "";
  document.getElementById("statDifferentiatorLabel").textContent = s.statDifferentiatorLabel || "";

  document.getElementById("footerLocation").textContent = s.location || "";
  document.getElementById("footerPhone").textContent = s.phone || "";
  document.getElementById("footerEmail").textContent = s.email || "";
  document.getElementById("footerHours").textContent = s.hours || "";

  const ig = document.getElementById("socialInstagram");
  const fb = document.getElementById("socialFacebook");
  if (s.instagram) ig.href = s.instagram;
  if (s.facebook) fb.href = s.facebook;

  const writeReviewBtn = document.getElementById("writeReviewBtn");
  writeReviewBtn.href = s.reviewUrl || s.facebook || "#";

  document.getElementById("tourWhatsappLink").href = whatsappLink(s.phone);

  document.getElementById("footerPrograms").innerHTML = state.programs
    .slice(0, 4)
    .map(p => `<li><a href="#programs">${escapeHTML(p.title)}</a></li>`)
    .join("");
}

/* ================= RENDER: PROGRAMS ================= */
function renderPrograms() {
  const grid = document.getElementById("programsGrid");
  grid.innerHTML = state.programs.map((p, i) => {
    const iconInner = p.icon
      ? `<img src="${escapeHTML(p.icon)}" alt="">`
      : escapeHTML(p.emoji || "🙂");
    return `
    <div class="card ${i % 2 === 0 ? "" : "blue"}" id="program-card-${i}">
      <div class="icon-circle">${iconInner}</div>
      <div class="age">${escapeHTML(p.age)}</div>
      <h3>${escapeHTML(p.title)}</h3>
      <p>${escapeHTML(p.desc)}</p>
      <div class="details">${escapeHTML(p.details)}</div>
      <button class="learn" data-toggle="program-card-${i}">Learn More →</button>
    </div>`;
  }).join("");
}

/* ================= RENDER: AGE GROUPS ================= */
function renderAgeGroups() {
  const grid = document.getElementById("ageGroupsGrid");
  grid.innerHTML = state.ageGroups.map((a, i) => `
    <div class="age-card" id="age-card-${i}">
      <span class="age-badge">${escapeHTML(a.badge)}</span>
      <h3>${escapeHTML(a.title)}</h3>
      <p>${escapeHTML(a.desc)}</p>
      <div class="details">${escapeHTML(a.details)}</div>
      <button class="learn" data-toggle="age-card-${i}">Learn More →</button>
    </div>`).join("");
}

/* ================= RENDER: TEAM ================= */
const TEAM_AVATAR_COLORS = ["var(--pink)", "var(--blue)", "var(--yellow)"];
function renderTeam() {
  const grid = document.getElementById("teamGrid");
  grid.innerHTML = state.team.map((person, i) => {
    const photoInner = person.photo
      ? `<img src="${escapeHTML(person.photo)}" alt="">`
      : escapeHTML((person.name || "?")[0]);
    return `
    <div class="test-card team-card">
      <div class="avatar team-avatar" style="background:${TEAM_AVATAR_COLORS[i % TEAM_AVATAR_COLORS.length]}">${photoInner}</div>
      <div class="name">${escapeHTML(person.name)}</div>
      <div class="role">${escapeHTML(person.role)}</div>
      <p class="credentials">${escapeHTML(person.credentials)}</p>
    </div>`;
  }).join("");
}

/* ================= RENDER: EVENTS ================= */
function isUpcoming(dateStr) {
  if (!dateStr) return false;
  const d = new Date(dateStr);
  if (isNaN(d)) return false;
  const startOfToday = new Date(new Date().toDateString());
  return d >= startOfToday;
}
function formatEventDate(dateStr) {
  const d = new Date(dateStr);
  if (isNaN(d)) return "";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
function eventCoverStyle(ev) {
  const cover = ev.photos && ev.photos[0] && ev.photos[0].image;
  return cover
    ? `background-image:url('${escapeHTML(cover)}');`
    : `background:${ev.color || "var(--pink-light)"};`;
}
function eventWhatsappLink(ev) {
  const msg = encodeURIComponent(`Hi! I'd like to know more about "${ev.title}" — is there still space to book?`);
  return `${whatsappLink(state.settings.phone)}?text=${msg}`;
}
function renderEvents() {
  const grid = document.getElementById("eventsGrid");
  grid.innerHTML = state.events.map((ev, i) => {
    const upcoming = isUpcoming(ev.date);
    const photoCount = (ev.photos || []).length;
    const mediaCount = photoCount + (ev.video ? 1 : 0);
    const badge = upcoming
      ? `<span class="event-badge">Upcoming</span>`
      : (ev.date ? `<span class="event-badge past">${escapeHTML(formatEventDate(ev.date))}</span>` : "");
    return `
    <div class="event-card ${i % 2 === 0 ? "" : "blue"}" data-event-index="${i}">
      <div class="event-cover" style="${eventCoverStyle(ev)}">
        ${badge}
        ${mediaCount > 0 ? `<span class="event-media-count">${ev.video ? "🎥 " : "📷 "}${mediaCount}</span>` : ""}
        ${(ev.photos && ev.photos[0] && ev.photos[0].image) ? "" : escapeHTML(ev.emoji || "🎉")}
      </div>
      <div class="event-body">
        <h3>${escapeHTML(ev.title)}</h3>
        <p>${escapeHTML(ev.description)}</p>
        ${upcoming ? `<a href="${eventWhatsappLink(ev)}" target="_blank" rel="noopener" class="btn btn-pink event-whatsapp-btn">Interested? Book via WhatsApp</a>` : ""}
      </div>
    </div>`;
  }).join("");
}
document.getElementById("eventsGrid").addEventListener("click", e => {
  if (e.target.closest(".event-whatsapp-btn")) return;
  const card = e.target.closest("[data-event-index]");
  if (card) openEventLightbox(Number(card.dataset.eventIndex));
});
function openEventLightbox(i) {
  const ev = state.events[i];
  if (!ev) return;
  document.getElementById("eventLightboxTitle").textContent = ev.title || "";
  document.getElementById("eventLightboxDesc").textContent = ev.description || "";

  const video = document.getElementById("eventLightboxVideo");
  if (ev.video) {
    video.src = ev.video;
    video.hidden = false;
  } else {
    video.removeAttribute("src");
    video.hidden = true;
  }

  const photos = ev.photos || [];
  const photoGrid = document.getElementById("eventLightboxGrid");
  photoGrid.innerHTML = photos.length
    ? photos.map(p => `<div class="lightbox-tile" style="background-image:url('${escapeHTML(p.image)}'); background-color:${ev.color || "var(--pink-light)"};"></div>`).join("")
    : `<div class="lightbox-tile" style="background:${ev.color || "var(--pink-light)"};">${escapeHTML(ev.emoji || "🎉")}</div>`;

  document.getElementById("eventLightbox").classList.add("open");
}
document.getElementById("eventLightboxClose").addEventListener("click", () => {
  document.getElementById("eventLightbox").classList.remove("open");
  document.getElementById("eventLightboxVideo").pause();
});
document.getElementById("eventLightbox").addEventListener("click", e => {
  if (e.target.id === "eventLightbox") {
    document.getElementById("eventLightbox").classList.remove("open");
    document.getElementById("eventLightboxVideo").pause();
  }
});

/* ================= RENDER: TESTIMONIALS ================= */
const AVATAR_COLORS = ["var(--pink)", "var(--blue)", "var(--yellow)"];
const TESTIMONIALS_PREVIEW_COUNT = 6;
let testimonialsExpanded = false;

function testimonialCardHTML(t, i) {
  return `
    <div class="test-card">
      <div class="quote-mark">"</div>
      <p class="quote">${escapeHTML(t.quote)}</p>
      <div class="who">
        <div class="avatar" style="background:${AVATAR_COLORS[i % AVATAR_COLORS.length]}">${escapeHTML((t.name || "?")[0])}</div>
        <div><div class="name">${escapeHTML(t.name)}</div><div class="role">${escapeHTML(t.role)}</div></div>
      </div>
    </div>`;
}

function renderTestimonials() {
  const grid = document.getElementById("testimonialsGrid");
  const visible = testimonialsExpanded ? state.testimonials : state.testimonials.slice(0, TESTIMONIALS_PREVIEW_COUNT);
  grid.innerHTML = visible.map(testimonialCardHTML).join("");

  const seeMoreBtn = document.getElementById("seeMoreTestimonials");
  if (state.testimonials.length <= TESTIMONIALS_PREVIEW_COUNT) {
    seeMoreBtn.hidden = true;
  } else {
    seeMoreBtn.hidden = false;
    seeMoreBtn.textContent = testimonialsExpanded
      ? "Show Fewer Reviews"
      : `See More Reviews (${state.testimonials.length - TESTIMONIALS_PREVIEW_COUNT} more)`;
  }
}
document.getElementById("seeMoreTestimonials").addEventListener("click", () => {
  testimonialsExpanded = !testimonialsExpanded;
  renderTestimonials();
  if (!testimonialsExpanded) document.getElementById("testimonials").scrollIntoView({ behavior: "smooth" });
});

/* ================= RENDER: GALLERY ================= */
let galleryFilter = "All";

function galleryTileStyle(g) {
  return g.image
    ? `background-image:url('${escapeHTML(g.image)}');`
    : `background:${g.color || "var(--pink-light)"};`;
}
function filteredGallery() {
  if (galleryFilter === "All") return state.gallery;
  return state.gallery.filter(g => (g.category || "General") === galleryFilter);
}
function renderGalleryFilters() {
  const el = document.getElementById("galleryFilters");
  const categories = [...new Set(state.gallery.map(g => g.category || "General"))];
  if (categories.length <= 1) { el.innerHTML = ""; return; }
  const all = ["All", ...categories];
  el.innerHTML = all.map(cat => `
    <button type="button" class="filter-pill${cat === galleryFilter ? " active" : ""}" data-category="${escapeHTML(cat)}">${escapeHTML(cat)}</button>
  `).join("");
}
document.getElementById("galleryFilters").addEventListener("click", e => {
  const btn = e.target.closest("[data-category]");
  if (!btn) return;
  galleryFilter = btn.dataset.category;
  renderGalleryFilters();
  renderGallery();
});
function renderGallery() {
  const strip = document.getElementById("galleryStrip");
  strip.innerHTML = filteredGallery().map(g => `
    <button class="gallery-tile" type="button" style="${galleryTileStyle(g)}" aria-label="${escapeHTML(g.alt || "Gallery photo")}">
      ${g.image ? "" : escapeHTML(g.emoji || "🙂")}
    </button>`).join("");
  strip.querySelectorAll(".gallery-tile").forEach(tile => tile.addEventListener("click", openLightbox));
}
function openLightbox() {
  document.getElementById("lightboxGrid").innerHTML = filteredGallery().map(g => `
    <div class="lightbox-tile" style="${galleryTileStyle(g)}">${g.image ? "" : escapeHTML(g.emoji || "🙂")}</div>
  `).join("");
  document.getElementById("lightbox").classList.add("open");
}

/* ================= PROGRAM SELECT OPTIONS ================= */
function populateProgramSelects() {
  const options = state.programs.map(p => `<option value="${escapeHTML(p.title)}">${escapeHTML(p.title)}</option>`).join("");
  ["enrollProgramSelect", "tourProgramSelect"].forEach(id => {
    const select = document.getElementById(id);
    select.innerHTML = `<option value="">Not sure yet</option>${options}`;
  });
}

/* ================= LEARN MORE TOGGLES (event delegation) ================= */
document.addEventListener("click", e => {
  const btn = e.target.closest("[data-toggle]");
  if (!btn) return;
  document.getElementById(btn.dataset.toggle)?.classList.toggle("expanded");
});

/* ================= MODAL ================= */
function openModal(which) {
  document.getElementById("modalEnroll").hidden = which !== "enroll";
  document.getElementById("modalTour").hidden = which !== "tour";
  document.getElementById("modalOverlay").classList.add("open");
}
function closeModal() {
  document.getElementById("modalOverlay").classList.remove("open");
}
document.addEventListener("click", e => {
  const opener = e.target.closest("[data-open-modal]");
  if (opener) {
    e.preventDefault();
    openModal(opener.dataset.openModal);
    return;
  }
  if (e.target.closest("[data-close-modal]")) {
    closeModal();
    return;
  }
  if (e.target.id === "modalOverlay") closeModal();
});

/* ================= LIGHTBOX CLOSE ================= */
document.getElementById("lightboxClose").addEventListener("click", () => document.getElementById("lightbox").classList.remove("open"));
document.getElementById("lightbox").addEventListener("click", e => {
  if (e.target.id === "lightbox") document.getElementById("lightbox").classList.remove("open");
});
document.getElementById("viewGalleryBtn").addEventListener("click", openLightbox);

/* ================= TOAST ================= */
function showToast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 3200);
}

/* ================= NETLIFY FORM SUBMISSION (AJAX) ================= */
function encodeFormData(data) {
  return Object.keys(data)
    .map(key => encodeURIComponent(key) + "=" + encodeURIComponent(data[key]))
    .join("&");
}
function wireNetlifyForm(formEl, successMessage) {
  formEl.addEventListener("submit", async e => {
    e.preventDefault();
    const formData = new FormData(formEl);
    const data = Object.fromEntries(formData.entries());
    data["form-name"] = formEl.getAttribute("name");
    try {
      await fetch("/", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: encodeFormData(data)
      });
      closeModal();
      formEl.reset();
      showToast(successMessage);
    } catch (err) {
      console.error("Form submission failed", err);
      showToast("Something went wrong — please try again or call us directly.");
    }
  });
}

/* ================= TOUR DATE MIN ================= */
document.getElementById("tourDateInput").min = new Date().toISOString().split("T")[0];

/* ================= NAV ================= */
document.getElementById("hamburger").addEventListener("click", () => {
  document.getElementById("navLinks").classList.toggle("open");
});
document.querySelectorAll("#navLinks a").forEach(a =>
  a.addEventListener("click", () => document.getElementById("navLinks").classList.remove("open"))
);

/* ================= INIT ================= */
(async function init() {
  try {
    await loadContent();
  } catch (err) {
    console.error("Failed to load site content", err);
    showToast("Some content failed to load — please refresh.");
    return;
  }
  renderSettings();
  renderPrograms();
  renderAgeGroups();
  renderTeam();
  renderEvents();
  renderTestimonials();
  renderGalleryFilters();
  renderGallery();
  populateProgramSelects();
  wireNetlifyForm(document.getElementById("enrollForm"), "Enrollment received! We'll contact you soon.");
  wireNetlifyForm(document.getElementById("tourForm"), "Tour request received! We'll be in touch.");
})();
