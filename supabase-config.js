/* ============================================================
   SUPABASE CONNECTION — public config

   All three values below are safe to publish. The publishable key is
   designed to ship in page source; it grants nothing on its own. The
   `prompts` schema has RLS enabled with a per-user policy scoped to the
   `authenticated` role, and `anon` is revoked from the schema itself —
   not merely from the tables — so this key can only be used to attempt
   a sign-in. The protection is the row-level security, not the secrecy
   of this file.

   The service_role key is a completely different thing. It bypasses
   RLS. It must never appear here, in any other file in this repo, or
   anywhere in the browser.

   WHERE TO GET THESE
     Supabase Dashboard -> Project Settings -> API
       url            = "Project URL"   (https://<ref>.supabase.co)
       publishableKey = "Project API keys" -> publishable (sb_publishable_...)
       schema         = the app's exposed Postgres schema (`prompts`)

   HOW TO SIGN IN
     There is no sign-up flow on purpose. Create the login yourself:
     Dashboard -> Authentication -> Users -> Add user -> "Create new user",
     with "Auto Confirm User" ticked so it works without an email round
     trip. The same account already signs in to Docket, Lists, Daily and
     Hut — Prompts is another schema in the same project, not another
     login.

   WHY COMMITTED RATHER THAN INJECTED AT DEPLOY
     Lists and Dough ship placeholders and substitute from GitHub
     Secrets in deploy-pages.yml. This repo follows Hut instead and
     commits the values directly, for two reasons: the file has to work
     when opened straight off disk during local development, and the
     project URL is already hardcoded in the Content-Security-Policy in
     index.html, so injecting it here would hide half of one value and
     none of the other. Both are publishable; neither is a secret.
   ============================================================ */

window.SUPABASE_CONFIG = {
  url: 'https://baiojghilzxhkebfblzv.supabase.co',
  publishableKey: 'sb_publishable_nfLVr5Krdld9pxxr4f2CYQ_bsn0TNxx',
  schema: 'prompts'
};
