const cfg = window.GEAR_CONFIG || {};
const $ = (s) => document.querySelector(s);
const msg = (t) => { const el = $("#msg"); if (el) el.textContent = t; };
const toEmail = (u) => `${String(u).toLowerCase()}@${cfg.emailDomain}`;
const validName = (u) => /^[A-Za-z0-9_]{3,20}$/.test(u);
const ownerEmail = () => toEmail(cfg.ownerUsername || "");
let mode = "in";

if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) {
  msg("Fill in config.js first (see SETUP.md).");
  if ($("#submit")) $("#submit").disabled = true;
} else {
  start();
}

// Eye button on each password box
const EYE = '<svg class="on" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="2"/></svg><svg class="off" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M3 3l18 18M10.6 5.1A10.5 10.5 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4.2M6.6 6.7C3.9 8.5 2 12 2 12s3.6 7 10 7c1.6 0 3-.4 4.3-1M9.9 9.9a3 3 0 0 0 4.2 4.2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
document.querySelectorAll(".pw").forEach((wrap) => {
  const input = wrap.querySelector("input");
  if (!input) return;
  const btn = document.createElement("button");
  btn.type = "button"; btn.className = "eye"; btn.innerHTML = EYE;
  btn.setAttribute("aria-pressed", "false");
  btn.setAttribute("aria-label", "Show password");
  btn.onclick = () => {
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    btn.setAttribute("aria-pressed", show);
    btn.setAttribute("aria-label", show ? "Hide password" : "Show password");
    input.focus();
  };
  wrap.append(btn);
});

function start() {
  const sb = supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
  const next = new URLSearchParams(location.search).get("next");

  function showSignedOut() {
    if ($("#form")) $("#form").hidden = false;
    if ($("#tabs")) $("#tabs").hidden = false;
    if ($("#done")) $("#done").hidden = true;
  }

  function showSignedIn(user) {
    if ($("#form")) $("#form").hidden = true;
    if ($("#tabs")) $("#tabs").hidden = true;
    if ($("#done")) $("#done").hidden = false;
    const owner = user.email === ownerEmail();
    if ($("#who")) $("#who").textContent = `Signed in as ${user.email.split("@")[0]}`;
    if ($("#adminlink")) $("#adminlink").hidden = !owner;
  }

  function setMode(m) {
    mode = m;
    if ($("#t-in")) $("#t-in").setAttribute("aria-current", m === "in" ? "true" : "false");
    if ($("#t-up")) $("#t-up").setAttribute("aria-current", m === "up" ? "true" : "false");
    if ($("#confirm-wrap")) $("#confirm-wrap").hidden = m === "in";
    if ($("#pass2")) $("#pass2").required = m === "up";
    if ($("#pass")) $("#pass").autocomplete = m === "in" ? "current-password" : "new-password";
    if ($("#submit")) $("#submit").textContent = m === "in" ? "Sign in" : "Create account";
    if ($("#forgot")) $("#forgot").hidden = m !== "in";
    if ($("#hint")) $("#hint").textContent = "Letters, numbers and underscores, 3 to 20 characters.";
  }

  if ($("#t-in")) $("#t-in").onclick = () => setMode("in");
  if ($("#t-up")) $("#t-up").onclick = () => setMode("up");
  setMode("in");

  async function isFree(name) {
    try {
      const { data, error } = await sb.rpc("username_available", { name });
      if (error) return null;
      return data;
    } catch {
      return null;
    }
  }

  let timer;
  if ($("#user")) {
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
  }

  if ($("#form")) {
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
  }

  // Sign out MUST clear UI so you can use another account
  async function doSignOut() {
    msg("");
    try {
      await sb.auth.signOut({ scope: "local" });
    } catch (_) {}
    try {
      await sb.auth.signOut({ scope: "global" });
    } catch (_) {}
    // Clear leftover supabase tokens from storage if signOut is flaky
    try {
      Object.keys(localStorage).forEach((k) => {
        if (/supabase|sb-|auth/i.test(k)) localStorage.removeItem(k);
      });
    } catch (_) {}
    showSignedOut();
    setMode("in");
    msg("Signed out. You can sign in with another account.");
  }

  if ($("#signout")) $("#signout").onclick = () => doSignOut();

  // View site — hard navigation (never stay on account.html)
  document.querySelectorAll("[data-go-site], a[href='index.html']").forEach((a) => {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      location.href = "index.html";
    });
  });

  if ($("#pwform")) {
    $("#pwform").onsubmit = async (e) => {
      e.preventDefault();
      const say = (t) => { const el = $("#pwmsg"); if (el) el.textContent = t; };
      if ($("#np").value !== $("#np2").value) return say("The two passwords don't match.");
      const { error } = await sb.auth.updateUser({ password: $("#np").value });
      if (error) return say(`Couldn't change it: ${error.message}`);
      $("#np").value = $("#np2").value = "";
      say("Password changed. Use the new one next time you sign in.");
    };
  }

  sb.auth.onAuthStateChange((_event, session) => {
    const user = session?.user;
    if (!user) {
      showSignedOut();
      return;
    }
    showSignedIn(user);
    // Only auto-redirect when we were sent here with ?next=...
    if (next === "index.html" || (user.email === ownerEmail() && next === "admin.html")) {
      try { location.replace(next); } catch (_) { location.href = next; }
    }
  });
}
