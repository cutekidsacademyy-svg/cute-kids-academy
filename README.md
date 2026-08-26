# Cute Kids Academy — Website

A plain HTML/CSS/JS static site. No build step, no framework.

- `index.html`, `css/style.css`, `js/main.js` — the site itself. `js/main.js` fetches the JSON files in `content/` at page load and renders the Programs, Age Groups, Testimonials, and Gallery sections.
- `content/*.json` — all editable content (text, programs, testimonials, gallery photos, contact info). Edit these directly, or edit them visually through `/admin`.
- `admin/` — [Decap CMS](https://decapcms.org) (formerly Netlify CMS), a free visual editor that writes back to the `content/*.json` files and lets you upload real images into `images/uploads/`.
- The "Enroll Now" and "Book a Tour" buttons open real [Netlify Forms](https://docs.netlify.com/manage/forms/setup/) — submissions show up in your Netlify dashboard and can email you automatically.

## 1. Push this folder to GitHub

From inside this `website` folder:

```bash
git init
git add .
git commit -m "Initial site"
```

Then create a new empty repository on GitHub (github.com → New repository — don't add a README/license there), and push:

```bash
git remote add origin https://github.com/YOUR_USERNAME/cute-kids-academy.git
git branch -M main
git push -u origin main
```

## 2. Connect the repo to Netlify

1. Go to [app.netlify.com](https://app.netlify.com) → **Add new site → Import an existing project**.
2. Choose GitHub and select the repository you just pushed.
3. Build settings: leave the **build command blank** and set **publish directory** to `.` (the repo root). `netlify.toml` already has this configured, so Netlify should pick it up automatically.
4. Click **Deploy site**. Your site will be live at a `*.netlify.app` URL (you can add a custom domain later under Domain settings).

## 3. Enable Netlify Identity + Git Gateway

This is what lets you log in at `/admin` and have your edits saved back to GitHub.

1. In your site's Netlify dashboard, go to **Site configuration → Identity** (or the **Identity** tab) → **Enable Identity**.
2. Under **Identity → Registration**, set registration to **Invite only** (so strangers can't sign themselves up as admins).
3. Still under Identity, go to **Services → Git Gateway** and click **Enable Git Gateway**. This lets Decap CMS commit content changes to your GitHub repo on your behalf, without you needing a personal GitHub token.
4. Open `admin/config.yml` in the repo and replace `site_url: https://your-site-name.netlify.app` with your actual Netlify URL, then commit and push that change.

## 4. Invite yourself as the first CMS admin user

1. Still in **Identity**, click **Invite users**, and send an invite to your own email address.
2. Check your email for the Netlify invite, click the link — it'll open your site and prompt you to set a password.
3. Once set, go to `https://YOUR-SITE-NAME.netlify.app/admin/` and log in with that email/password.
4. You should now see the Decap CMS dashboard with **Site Settings**, **Programs**, **Age Groups**, **Testimonials**, and **Gallery** — edit away. Saving in the CMS commits directly to your GitHub repo, which triggers Netlify to redeploy the live site automatically within a minute or two.

## Editing content without the CMS

You can also just edit the JSON files in `content/` directly in GitHub or locally and push — the CMS is optional convenience, not a requirement.

## Checking form submissions

Netlify dashboard → your site → **Forms**. You'll see two forms, `enroll` and `tour`, with every submission. Under **Forms → Settings and usage → Form notifications**, add an **email notification** to get emailed on every new submission.

## Local preview

No build tools needed — any static file server works, e.g.:

```bash
npx serve .
```

Note: content fetching (`fetch('/content/...')`) requires serving over `http://`, not opening `index.html` directly as a `file://` URL. The Decap CMS admin panel (`/admin`) also won't function locally without either Netlify Dev or the `local_backend` option — it's meant to be used against the deployed Netlify site.
