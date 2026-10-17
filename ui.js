// Back-to-top button, shown after scrolling down. Loaded on every page.
(() => {
  const b = document.createElement("button");
  b.id = "totop"; b.type = "button"; b.hidden = true;
  b.setAttribute("aria-label", "Back to top");
  b.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  b.onclick = () => window.scrollTo({ top: 0, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  document.body.append(b);
  const toggle = () => { b.hidden = window.scrollY < 400; };
  addEventListener("scroll", toggle, { passive: true });
  toggle();
})();
