# AliCreates — Full-stack product video ads portfolio

This is the full source code for a two-area website:
- Public client website at `/`
- Private admin dashboard at `/admin`

## Features
- Responsive dark navy / electric blue / yellow design.
- Public video portfolio, category filters, playback modal, service/about/contact sections.
- Admin login using a PostgreSQL-stored bcrypt password hash and server-side session.
- Admin dashboard to add/edit/delete samples; updates appear publicly immediately.
- Upload videos from phone/computer to Cloudinary (when credentials are configured), or add a public YouTube/direct video URL.
- Admin can update WhatsApp, email, Instagram, TikTok, Facebook and X/Twitter links.
- Admin can change password.
- Rate-limited login, secure cookie flags, Helmet security headers, input validation and environment secrets.
- PostgreSQL persistence; media storage externalized to Cloudinary for deployment-safe uploads.

## Required setup (hosting/domain comes later)
1. Install Node.js 20+ and PostgreSQL for local computer testing, or use hosted PostgreSQL later.
2. Copy `.env.example` to `.env`.
3. Set `DATABASE_URL`, `ADMIN_EMAIL`, `ADMIN_PASSWORD` (12+ character unique password recommended), and a random `SESSION_SECRET` of 32+ characters.
4. For actual video file uploads, create a Cloudinary account and set `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`. If not configured, admin can still add public YouTube/direct URLs.
5. Run `npm install`, then `npm start`.
6. Open `http://localhost:3000` for public site and `http://localhost:3000/admin` for admin.
7. The first admin account is created from the `ADMIN_EMAIL` and `ADMIN_PASSWORD` environment values when the server first starts. Change password in the dashboard after login.

## Mobile-only reality
The source is prepared so hosting/domain setup can be done later. Running a full Node.js + PostgreSQL backend locally on a phone is not as simple as opening HTML in Acode. You can upload this project to GitHub from mobile and later connect Render + PostgreSQL + Cloudinary. The app needs those hosted services configured before it can be live and persist admin uploads.

## Deploying later
- Push all project files to a GitHub repository.
- Create a PostgreSQL database (Render Postgres or another provider).
- Create a Render web service from the repository, using `npm install` and `npm start`, or use `render.yaml` as a deployment blueprint.
- Add all `.env.example` values as Render environment variables. Do not commit `.env`.
- Set `PGSSL=true` if required by the provider.
- Configure Cloudinary credentials for video uploads.
- Add a custom domain later from hosting provider settings and configure DNS.

Render's default filesystem is ephemeral; this project stores database data in PostgreSQL and video media in Cloudinary so uploaded work doesn't disappear on redeploy.

## Important
- No domain, hosting, database or Cloudinary account is included. The project is source code, not a live deployed site.
- Never share `.env`, database passwords, Cloudinary API secret, or admin password.
- Add only real testimonials, genuine portfolio work, and honest claims.
