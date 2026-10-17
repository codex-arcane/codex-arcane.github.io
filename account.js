const cfg = window.GEAR_CONFIG || {};
const $ = (s) => document.querySelector(s);
const msg = (t) => ($("#msg").textContent = t);
const toEmail = (u) => `${u.toLowerCase()}@${cfg.emailDomain}`;
const validName = (u) => /^[A-Za-z0-9_]{3,20}$/.test(u);
const ownerEmail = () => toEmail(cfg.ownerUsername || "");
let mode = "in";

if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) {
  msg("Fill in config.js first (see SETUP.md).");
  $("#submit").disabled = true;
} else {
  start();
}

function start() {
  const sb = supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
  const next = new URLSearchParams(location.search).get("next");

  function setMode(m) {
    mode = m;
    $("#t-in").setAttribute("aria-current", m === "in");
    $("#t-up").setAttribute("aria-current", m === "up");
    $("#confirm-wrap").hidden = m === "in";
    $("#pass2").required = m === "up";
    $("#pass").autocomplete = m === "in" ? "current-password" : "new-password";
    $("#submit").textContent = m === "in" ? "Sign in" : "Create account";
    $("#hint").textContent = "Letters, numbers and underscores, 3 to 20 characters.";
    msg("");
  }
  $("#t-in").onclick = () => setMode("in");
  $("#t-up").onclick = () => setMode("up");

  async function isFree(name) {
    const { data, error } = await sb.rpc("username_available", { name });
    return error ? null : data;
  }

  // Warn about a taken username while typing, before the form is submitted.
  let timer;
  $("#user").oninput = () => {
    if (mode !== "up") return;
    clearTimeout(timer);
    const name = $("#user").value.trim();
    if (!validName(name)) return ($("#hint").textContent = "Letters, numbers and underscores, 3 to 20 characters.");
    timer = setTimeout(async () => {
      const free = await isFree(name);
      if ($("#user").value.trim() !== name) return;
      $("#hint").textContent = free === null ? "" : free ? "That username is available." : "That username is already taken. Pick another.";
    }, 400);
  };

  $("#form").onsubmit = async (e) => {
    e.preventDefault();
    const name = $("#user").value.trim(), password = $("#pass").value;
    if (!validName(name)) return msg("Username must be 3 to 20 letters, numbers or underscores.");
    $("#submit").disabled = true;
    try {
      if (mode === "in") {
        const { error } = await sb.auth.signInWithPassword({ email: toEmail(name), password });
        if (error) msg("Wrong username or password.");
      } else {
        if (password !== $("#pass2").value) return msg("The two passwords don't match.");
        if ((await isFree(name)) === false) return msg("That username is already taken. Pick another.");
        const { data, error } = await sb.auth.signUp({ email: toEmail(name), password });
        if (error) {
          msg(/registered|exists/i.test(error.message) ? "That username is already taken. Pick another." : `Couldn't create the account: ${error.message}`);
        } else if (!data.session) {
          msg("Account created, but Supabase still wants email confirmation. Turn off Confirm email (see SETUP.md).");
        }
      }
    } finally {
      $("#submit").disabled = false;
    }
  };

  $("#signout").onclick = () => sb.auth.signOut();

  sb.auth.onAuthStateChange((_event, session) => {
    const user = session?.user;
    $("#form").hidden = !!user;
    $("#tabs").hidden = !!user;
    $("#done").hidden = !user;
    if (!user) return;
    const owner = user.email === ownerEmail();
    $("#who").textContent = `Signed in as ${user.email.split("@")[0]}`;
    $("#adminlink").hidden = !owner;
    if (next === "index.html" || (owner && next === "admin.html")) location.replace(next);
  });
}
