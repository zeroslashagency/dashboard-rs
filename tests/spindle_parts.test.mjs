// Behavioral test for the "Part count instead of RPM graph" card option.
// Loads the shipped web/js/app.js into a VM with a minimal DOM/localStorage
// stub. Run: node --test apps/dashboard-rs/tests/spindle_parts.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = fs.readFileSync(path.join(here, "../web/js/app.js"), "utf8");

// Element stub: records text/classes/attrs, answers any other property/method
// with a harmless no-op so updateCard's unrelated writes do not throw.
function fakeEl(name) {
  const cls = new Set();
  const attrs = {};
  const target = {
    __name: name,
    textContent: "",
    className: "",
    dataset: {},
    style: { setProperty() {}, removeProperty() {} },
    hidden: false,
    title: "",
    children: [],
    classList: {
      contains: (c) => cls.has(c),
      toggle: (c, on) => { const v = on === undefined ? !cls.has(c) : !!on; v ? cls.add(c) : cls.delete(c); return v; },
      add: (c) => cls.add(c),
      remove: (c) => cls.delete(c),
    },
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    setAttribute: (k, v) => { attrs[k] = String(v); },
    removeAttribute: (k) => { delete attrs[k]; },
    hasAttribute: (k) => k in attrs,
    toggleAttribute: (k, on) => { if (on) attrs[k] = ""; else delete attrs[k]; },
    closest: () => fakeEl(name + ":closest"),
    querySelector: () => null,
    querySelectorAll: () => [],
    appendChild: (c) => c,
    addEventListener() {},
    getContext: () => null,
  };
  return new Proxy(target, {
    get(t, k) {
      if (k in t) return t[k];
      if (typeof k === "symbol") return undefined;
      return () => {};
    },
    set(t, k, v) { t[k] = v; return true; },
  });
}

function boot(storage = {}) {
  const store = new Map(Object.entries(storage));
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
  };
  const html = fakeEl("html");
  const document = {
    readyState: "loading",
    documentElement: html,
    hidden: false,
    addEventListener() {},
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: (t) => fakeEl(t),
    body: fakeEl("body"),
  };
  const window = {
    location: { hostname: "127.0.0.1", origin: "http://127.0.0.1:9995", search: "" },
    addEventListener() {},
  };
  const ctx = {
    window, document, localStorage, location: window.location, console,
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    requestAnimationFrame: () => 0, fetch: () => new Promise(() => {}),
    Date, Math, JSON, Number, String, Object, Array, Map, Set, WeakMap, Promise, URLSearchParams,
    performance, Intl,
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(
    APP + "\n;globalThis.__T__ = { get dashPrefs() { return dashPrefs; }, sanitizePrefPatch, applyPrefsToDom, updateCard, paintParts, dashSectionsHTML, DASH_PREFS_DEFAULTS };",
    ctx,
  );
  return { T: ctx.__T__, S: window.__VMC_DASH_SETTINGS__, html, store };
}

function card() {
  const refs = {};
  const entry = {
    root: fakeEl("card"),
    refs: new Proxy(refs, { get: (t, k) => (k in t ? t[k] : (t[k] = fakeEl(String(k)))) }),
  };
  return entry;
}

const machine = (id, parts, extra = {}) => ({
  machine_id: id, machine_name: id, online: true, execution: "ACTIVE",
  controller_mode: "AUTOMATIC", spindle_speed: 4200, part_count: parts,
  overrides: { feed: 100, rapid: 100, spindle: 100 }, ...extra,
});

test("default is off: graph shown, html flag off", () => {
  const { T, html } = boot();
  assert.equal(T.DASH_PREFS_DEFAULTS.spindleParts, false);
  assert.equal(T.dashPrefs.spindleParts, false);
  assert.equal(html.dataset.spindleParts, "off");
});

test("exactly one checkbox, in the shared Machine cards section", () => {
  const { T } = boot();
  const cls = { sec: "s", title: "t", row: "r", hint: "h", btn: "b", btns: "" };
  const cards = T.dashSectionsHTML(cls, ["cards"]);
  assert.equal(cards.match(/data-dc="spindleParts"/g).length, 1);
  assert.match(cards, /Part count instead of RPM graph/);
  const all = T.dashSectionsHTML(cls);
  assert.equal(all.match(/data-dc="spindleParts"/g).length, 1);
});

test("sanitize keeps booleans only (import/export + storage path)", () => {
  const { T } = boot();
  assert.deepEqual({ ...T.sanitizePrefPatch({ spindleParts: true }) }, { spindleParts: true });
  assert.deepEqual({ ...T.sanitizePrefPatch({ spindleParts: "yes" }) }, {});
});

test("Global scope persists and survives reload; This display overrides it", () => {
  const b1 = boot();
  b1.S.set("global", "spindleParts", true);
  assert.equal(b1.html.dataset.spindleParts, "on");
  assert.equal(JSON.parse(b1.store.get("vmc_dash_global_v2")).spindleParts, true);

  const b2 = boot(Object.fromEntries(b1.store));   // reload
  assert.equal(b2.T.dashPrefs.spindleParts, true);
  assert.equal(b2.html.dataset.spindleParts, "on");

  b2.S.set("device", "spindleParts", false);        // display overrides global
  assert.equal(b2.T.dashPrefs.spindleParts, false);
  assert.equal(b2.html.dataset.spindleParts, "off");
  assert.equal(JSON.parse(b2.store.get("vmc_dash_global_v2")).spindleParts, true);

  const b3 = boot(Object.fromEntries(b2.store));
  assert.equal(b3.T.dashPrefs.spindleParts, false);
  b3.S.reset("device");                             // back to Global
  assert.equal(b3.T.dashPrefs.spindleParts, true);
  assert.equal(b3.html.dataset.spindleParts, "on");
});

test("readout is the same per-machine value as the PARTS box", () => {
  const { T } = boot();
  const a = card(), b = card();
  T.updateCard(a, machine("VMC-02", 17));
  T.updateCard(b, machine("VMC-03", 942));
  T.paintParts(a); T.paintParts(b);
  assert.equal(a.refs.spindlePartsVal.textContent, "17");
  assert.equal(a.refs.spindlePartsVal.textContent, a.refs.parts.textContent);
  assert.equal(b.refs.spindlePartsVal.textContent, "942");
  assert.equal(b.refs.spindlePartsVal.textContent, b.refs.parts.textContent);
  // part_count_total wins over part_count, exactly like the PARTS box.
  const c = card();
  T.updateCard(c, machine("VMC-04", 5, { part_count_total: 88 }));
  T.paintParts(c);
  assert.equal(c.refs.spindlePartsVal.textContent, "88");
  assert.equal(c.refs.parts.textContent, "88");
});

test("offline machine with no count field renders a dash, not a number", () => {
  const { T } = boot();
  const offline = machine("VMC-05", 0, { online: false, execution: "UNAVAILABLE", spindle_speed: null });
  delete offline.part_count;                 // collector omits the field entirely
  const e = card();
  T.updateCard(e, offline);
  T.paintParts(e);
  assert.equal(e.refs.spindlePartsVal.textContent, "—");
  assert.equal(e.refs.parts.textContent, "—");
});

test("null part_count (PARTS box shows 0) is still unknown in the readout", () => {
  const { T } = boot();
  const e = card();
  T.updateCard(e, machine("VMC-07", null, { online: false }));
  T.paintParts(e);
  assert.equal(e.refs.spindlePartsVal.textContent, "—");
});

test("a count that disappears from the feed clears the readout, never goes stale", () => {
  const { T } = boot();
  const k = card();
  T.updateCard(k, machine("VMC-06", 12));
  T.paintParts(k);
  assert.equal(k.refs.spindlePartsVal.textContent, "12");
  const gone = machine("VMC-06", 0, { online: false });
  delete gone.part_count;
  T.updateCard(k, gone);
  T.paintParts(k);
  assert.equal(k.refs.spindlePartsVal.textContent, "—");
});
