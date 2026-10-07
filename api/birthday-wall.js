// POST /api/birthday-wall   (public: the birthday wall page at /birthdays/)
// The only place child data reaches a public page: this month's birthdays as a first name, one initial and the age, and only for
// children whose parents agreed to the wall when registering (a parent can withdraw it at any time). The database function does
// the filtering; this function adds nothing, trims every field and limits how often one visitor can ask.
const { HttpError, publicEndpoint, visitorKey } = require("./_lib/portal.js");

module.exports = publicEndpoint(async ({ req, client, env }) => {
  const ok = await client.call("/rest/v1/rpc/registration_rate_hit", { method: "POST", body: { p_key: visitorKey(req, env, "wall"), p_limit: 120 } });
  if (ok === false) throw new HttpError(429, "Please try again a little later.", "rate");
  const rows = await client.call("/rest/v1/rpc/birthday_wall", { method: "POST", body: {} });
  const children = (Array.isArray(rows) ? rows : []).slice(0, 200).map((r) => ({
    first_name: String(r.first_name || "").slice(0, 40),
    initial: String(r.initial || "").slice(0, 1),
    day: Number(r.day) || 0,
    turning: Number(r.turning) || 0,
    is_today: r.is_today === true,
  }));
  return { children };
}, { maxBytes: 2000 });
