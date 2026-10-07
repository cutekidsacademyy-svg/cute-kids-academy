// Public settings for the parent portal. These two values are PUBLIC by design (they are
// visible to every browser), so it is safe to keep them in Git. The SECRET service key never
// goes here: it lives only in Vercel's environment variables.
//
// Project URL and "anon public" key from Supabase: Project Settings > API.
window.CKA_PORTAL = {
  // Public key for web push notifications (made in the launch checklist; safe to publish). Empty = push stays off.
  vapidPublicKey: "",
  supabaseUrl: "https://ocamgidbsjwbyxhlnysq.supabase.co",
  supabaseAnonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9jYW1naWRic2p3Ynl4aGxueXNxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTEzMDYyOTUsImV4cCI6MjEwNjg4MjI5NX0.yyRygB4gbUZ4h0pH2-GUoMDXKTb4nXWuzo1p4I-twEs"
};
