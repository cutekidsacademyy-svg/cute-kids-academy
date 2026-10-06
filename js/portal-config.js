// Public settings for the parent portal. These two values are PUBLIC by design (they are
// visible to every browser), so it is safe to keep them in Git. The SECRET service key never
// goes here: it lives only in Vercel's environment variables.
//
// Fill in from Supabase: Project Settings > API > "Project URL" and the "anon public" key.
// While they are empty, the portal pages show "not switched on yet" and the public site is unaffected.
window.CKA_PORTAL = {
  supabaseUrl: "",
  supabaseAnonKey: ""
};
