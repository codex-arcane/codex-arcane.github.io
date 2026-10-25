# Owner panel and accounts setup (one time, about 10 minutes)

GitHub Pages can only serve files, so accounts and uploads live in Supabase
(free plan, no card needed) and the public site reads from there.

1. Create a project at supabase.com. Note the Project URL and the anon public key
   (Project settings > API).
2. Authentication > Sign In / Providers > Email: keep Email enabled and turn OFF
   "Confirm email". Usernames are stored as fake emails, so nothing can be confirmed.
3. SQL Editor: paste `supabase-setup.sql` and run it. (It already uses the username
   codexarcane and the domain gear-users.app. Change both there and in config.js
   if you want different ones.)
4. Fill in `config.js` (URL and anon key), commit, push.
5. IMPORTANT: open `/account.html`, choose Create account, and register `codexarcane`
   before anyone else can. The first person to register that name becomes the owner.
6. Open `/admin.html` (signing in as codexarcane sends you there), add a category by
   picking its .json, then upload your images folder.

Notes
- Visitors don't have to sign in. Guests keep their settings and favorites in their own browser;
  signed-in users also get them saved to their account (table `user_settings`, readable only by
  that user). If you ran an older copy of the SQL file, just run the new one again: it is safe to repeat.
- Only the codexarcane account can upload or delete: enforced by the policies in the SQL
  file. Other accounts can sign in but see "not allowed" on the owner panel.
- There is no password reset (no real email is stored). If you forget a password, reset it
  in Supabase under Authentication > Users.
- If Supabase rejects the fake email domain when creating an account, change the domain
  in `config.js` and in the SQL file (three places in the policies, one in the trigger).
- Free plan limits: 1 GB storage, 50 MB per file.
- With `supabaseUrl` left empty, the site keeps using the local `data/` folder.

## Skill Database layout
- The menu shows Skill Database > Assist / Buff / Other / Weapon > one entry per skill tree (Blade Skills, Battle Skills, ...).
- In the owner panel, pick the group **Skill Database** when adding a category and a **Section** picker appears. Dropping
  `skilldatabase_all.json` (or the whole scraper output folder) files every tree under the section the scraper recorded.
- If Weapon, Buff, Assist and Other still exist as separate groups from an older upload, press
  **Move skill groups into Skill Database** in the owner panel once.
- Opening a skill category shows the skills as a page (search box + one expandable row per skill). Nothing in that page is
  specific to one tree, so every category from the scraper renders the same way.
