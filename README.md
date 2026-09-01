# Cute Kids Academy — Website

A plain HTML/CSS/JS static site. No build step, no framework.

- `index.html`, `css/style.css`, `js/main.js` — the site itself. `js/main.js` fetches the JSON files in `content/` at page load and renders Programs, Age Groups, Team, Events, Testimonials, and Gallery.
- `content/*.json` — all editable content (text, programs, testimonials, gallery photos, events, contact info). Edit these directly, or edit them visually through `/admin`.
- `admin/` — [Sveltia CMS](https://github.com/sveltia/sveltia-cms), a free visual editor (a modern, drop-in-compatible alternative to Decap/Netlify CMS) that writes back to the `content/*.json` files and lets you upload real images into `images/uploads/`. It logs in with GitHub directly.
- `api/auth.js` and `api/callback.js` — two small serverless functions that let the CMS log you in with GitHub, without ever exposing a secret to the browser. This is the only "backend" the site has.
- The "Enroll Now" and "Book a Tour" buttons submit through [Formspree](https://formspree.io) — submissions show up in your Formspree dashboard and email you automatically.

## 1. Push this folder to GitHub

*(Skip this if it's already pushed.)* From inside this `website` folder:

```bash
git init
git add .
git commit -m "Initial site"
```

Create a new empty repository on GitHub (github.com → New repository — don't add a README/license there), then:

```bash
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
git branch -M main
git push -u origin main
```

## 2. Deploy to Vercel

1. Go to [vercel.com/new](https://vercel.com/new) → **Import Git Repository** → pick your repo.
2. Framework Preset: **Other**. Leave **Build Command** blank. **Output Directory**: `.` (repo root).
3. Click **Deploy**. You'll get a live `*.vercel.app` URL in under a minute. Vercel automatically picks up `api/auth.js` and `api/callback.js` as serverless functions — no extra config needed.

## 3. Set up Formspree (for Enroll/Tour form submissions)

1. Go to [formspree.io](https://formspree.io) and create a free account.
2. Create a new form (any name, e.g. "Cute Kids Academy — Website"). Formspree gives you a form ID like `abcdwxyz`.
3. Log into `/admin` (see step 5 below) and paste that ID into **Site Settings → Formspree Form ID**. Both the Enroll and Tour forms share this one ID — a hidden `formType` field on each submission tells you which form it came from.
4. In Formspree's dashboard, under your form's **Settings → Notifications**, confirm email alerts are turned on.

## 4. Set up GitHub OAuth (so you can log into `/admin`)

1. Go to [github.com/settings/developers](https://github.com/settings/developers) → **OAuth Apps → New OAuth App**.
2. Fill in:
   - **Application name**: anything, e.g. "Cute Kids Academy CMS"
   - **Homepage URL**: your Vercel URL, e.g. `https://your-site-name.vercel.app`
   - **Authorization callback URL**: `https://your-site-name.vercel.app/api/callback`
3. Click **Register application**. You'll get a **Client ID**. Click **Generate a new client secret** and copy it — GitHub only shows it once.
4. In your Vercel project: **Settings → Environment Variables**, add:
   - `GITHUB_OAUTH_CLIENT_ID` = the Client ID
   - `GITHUB_OAUTH_CLIENT_SECRET` = the Client Secret
5. Redeploy the site (Vercel → Deployments → ⋯ → Redeploy) so the new environment variables take effect.
6. Open `admin/config.yml` in the repo and replace both placeholder URLs (`base_url` and `site_url`, currently `https://your-site-name.vercel.app`) with your actual Vercel URL, then commit and push.

## 5. Log into `/admin`

Go to `https://your-site-name.vercel.app/admin/`, click **Log in with GitHub**, and authorize the OAuth App you just created. You'll need push access to the GitHub repo (if it's just you, you already have it). You should now see the Sveltia CMS dashboard with **Site Settings**, **Programs**, **Age Groups**, **Team**, **Events**, **Testimonials**, and **Gallery** — edit away. Saving commits directly to your GitHub repo, which triggers Vercel to redeploy the live site automatically within a minute or two.

## Editing content without the CMS

You can also just edit the JSON files in `content/` directly in GitHub or locally and push — the CMS is optional convenience, not a requirement.

## Checking form submissions

Log into [formspree.io](https://formspree.io) → your form → **Submissions**. Each one has a `formType` field (`enroll` or `tour`) so you can tell them apart.

## Local preview

No build tools needed for the static site itself, e.g.:

```bash
npx serve .
```

Note: content fetching (`fetch('/content/...')`) requires serving over `http://`, not opening `index.html` directly as a `file://` URL. The `/admin` CMS and the OAuth functions in `/api` won't work in this simple local preview — they need to run on Vercel (or via `vercel dev`, if you have the Vercel CLI installed) since the OAuth handshake depends on a real, publicly reachable callback URL.
