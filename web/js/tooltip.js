/* VMC God-mode — lightweight hover tooltip.
 *
 * One floating box, event-delegated. Any element carrying a `data-tip`
 * attribute (optionally `data-tip-title`) shows an explanatory pop-up on hover
 * describing what the value means and how it impacts the machine/system.
 *
 * Rich body is rendered as plain text (textContent) so attribute content is
 * always safe — the title is emphasised via CSS, no HTML injection.
 */

let pop = null;

function ensure() {
  if (pop) return pop;
  pop = document.createElement("div");
  pop.className = "tip-pop";
  pop.innerHTML = `<div class="tip-title"></div><div class="tip-body"></div>`;
  document.body.appendChild(pop);
  return pop;
}

function show(target) {
  const title = target.getAttribute("data-tip-title") || "";
  const body = target.getAttribute("data-tip") || "";
  if (!title && !body) return;
  const el = ensure();
  const tEl = el.querySelector(".tip-title");
  const bEl = el.querySelector(".tip-body");
  tEl.textContent = title;
  tEl.style.display = title ? "" : "none";
  bEl.textContent = body;
  bEl.style.display = body ? "" : "none";
  // make measurable, then place
  el.style.visibility = "hidden";
  el.classList.add("is-show");
  position(el, target);
  el.style.visibility = "";
}

function position(el, target) {
  const r = target.getBoundingClientRect();
  const pr = el.getBoundingClientRect();
  const gap = 10;
  let top = r.top - pr.height - gap;
  let place = "top";
  if (top < 8) { top = r.bottom + gap; place = "bottom"; }
  let left = r.left + r.width / 2 - pr.width / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - pr.width - 8));
  el.style.top = `${Math.round(top)}px`;
  el.style.left = `${Math.round(left)}px`;
  el.dataset.place = place;
  // arrow points at the target centre
  const ax = r.left + r.width / 2 - left;
  el.style.setProperty("--tip-arrow", `${Math.max(12, Math.min(ax, pr.width - 12))}px`);
}

function hide() { if (pop) pop.classList.remove("is-show"); }

/* Attach delegated hover handling to a root container. Safe to call once per
 * mount; renders that replace innerHTML inside the root keep working. */
export function initTooltips(root) {
  if (root.__tipBound) return;
  root.__tipBound = true;
  root.addEventListener("mouseover", (e) => {
    const t = e.target.closest("[data-tip],[data-tip-title]");
    if (t && root.contains(t)) show(t);
  });
  root.addEventListener("mouseout", (e) => {
    const t = e.target.closest("[data-tip],[data-tip-title]");
    if (!t) return;
    if (e.relatedTarget && t.contains(e.relatedTarget)) return; // moved within same target
    hide();
  });
  // hide on scroll/leave so it never strands over content
  root.addEventListener("mouseleave", hide);
  window.addEventListener("scroll", hide, true);
}

/* Escape a string for safe use inside a double-quoted HTML attribute. */
export function tipAttr(s) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/"/g, "&quot;")
    .replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
