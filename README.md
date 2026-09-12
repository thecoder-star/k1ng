# k1ng

A static, jsDelivr-compatible game portal with profiles, friends, direct/group chat, media messages, read receipts, one-to-one WebRTC calls, and a Supabase-backed admin console.

## Run the visual preview

The frontend works without Supabase in read-only preview mode.

```powershell
python -m http.server 8080
```

Open `http://localhost:8080` and choose **Preview without an account**.

## Connect a new Supabase project

Do not use the existing unrelated Supabase project. Create a dedicated project, then:

1. Install the Supabase CLI.
2. Link this folder to the new project.
3. Apply the migration.
4. Deploy both Edge Functions.
5. Add the new project URL and publishable key to `assets/js/config.js`.

```powershell
npx supabase login
npx supabase link --project-ref YOUR_NEW_PROJECT_REF
npx supabase db push
npx supabase functions deploy admin-api
npx supabase functions deploy access-gate --no-verify-jwt
```

Set server-only secrets:

```powershell
npx supabase secrets set ALLOWED_ORIGINS="http://localhost:8080,https://YOUR_SITE.example"
npx supabase secrets set GATE_RATE_LIMIT_SALT="A_LONG_RANDOM_VALUE"
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are provided automatically to deployed Edge Functions. Never put the service-role key, TURN passwords, or other private secrets in frontend files.

## Create the first admin

Sign up normally, then run this once in the Supabase SQL editor using the new user's UUID:

```sql
insert into public.admin_roles (user_id)
values ('USER_UUID_HERE');
```

Admin access is based on this database role. The global access password is not an admin password.

## Game catalog

The initial library reads the authorized GN-Math manifest configured in `assets/js/config.js`. Admin-created entries are stored in Supabase and appear before remote catalog entries.

Fetched game HTML is launched in a sandboxed document. Remote game code still comes from its source, so only add URLs you trust and are permitted to redistribute.

## Calls

Supabase Realtime carries WebRTC signaling. Audio/video travels peer-to-peer. The default public STUN server is suitable for development, but many production networks require a TURN relay. Add your provider's ICE configuration to `assets/js/config.js`; do not expose reusable privileged TURN credentials.

## Publish through GitHub and jsDelivr

1. Push the project to a GitHub repository.
2. Use immutable release tags for production, for example `v1.0.0`.
3. Host `launcher.html` on any static host.
4. Enter `YOUR_GITHUB_USER/YOUR_REPOSITORY` and the release tag in the loader.

The loader fetches `index.html`, CSS, configuration, and application JavaScript
through jsDelivr, bundles them in memory, and writes the preloaded result into a
new `about:blank` tab. You can prefill it with:

```text
launcher.html?repo=YOUR_GITHUB_USER/YOUR_REPOSITORY&ref=v1.0.0
```

Avoid using `@main` in production because CDN caches may not update immediately.

## Security notes

- Row-level security limits profiles, friendships, chats, receipts, and media to authorized users.
- Private chat media uses short-lived signed URLs.
- Admin mutations run through a JWT-protected Edge Function and are audited.
- The global password gate hides the app UI and rate-limits attempts. Static files on a CDN are always downloadable, so it is not a substitute for user authentication.
- Configure production email, CAPTCHA/rate limits, retention rules, moderation/reporting, and a privacy policy before opening registration publicly.
