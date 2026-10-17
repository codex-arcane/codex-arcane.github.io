// Fill these in after creating your Supabase project (see SETUP.md).
// The anon key is meant to be public. Who can write is enforced by the SQL policies, not by hiding this key.
// Leave supabaseUrl empty to keep using the local data/ folder instead.
window.GEAR_CONFIG = {
  supabaseUrl: "",        // e.g. "https://abcdxyz.supabase.co"
  supabaseAnonKey: "",    // Project settings > API > anon public key
  ownerUsername: "codexarcane",
  // Usernames are stored as <username>@<emailDomain> behind the scenes. Never shown to anyone.
  // Must match the domain used in supabase-setup.sql.
  emailDomain: "gear-users.app",
};
