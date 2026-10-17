// Fill these in after creating your Supabase project (see SETUP.md).
// The anon key is meant to be public. Who can write is enforced by the SQL policies, not by hiding this key.
// Leave supabaseUrl empty to keep using the local data/ folder instead.
window.GEAR_CONFIG = {
  supabaseUrl: "https://dtirdzshfvqqzmsibtfq.supabase.co/",        // e.g. "https://abcdxyz.supabase.co"
  supabaseAnonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImR0aXJkenNoZnZxcXptc2lidGZxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTIyMzk2MzgsImV4cCI6MjEwNzgxNTYzOH0.heBDmtduHKorcl374-S13czCMzGAoW90skCbmTPhm4g",    // Project settings > API > anon public key
  ownerUsername: "codexarcane",
  // Usernames are stored as <username>@<emailDomain> behind the scenes. Never shown to anyone.
  // Must match the domain used in supabase-setup.sql.
  emailDomain: "gear-users.app",
};
