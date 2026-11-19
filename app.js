/* Kleinanzeigen-Agent – Weboberfläche.
 * Liest/schreibt watchlist.yaml und liest state.json im privaten Repo über die GitHub-API.
 * Alle Texte aus Anzeigen werden per textContent gesetzt (nie als HTML).
 */
"use strict";

const LS_TOKEN = "ka.token";
const LS_REPO = "ka.repo";
const DEFAULT_REPO = "skiingd/Kleinanzeigenagent";
const WORKFLOW = "suche.yml";
const BRANCH = "main";
const MAX_QUERIES = 10; // muss zu MAX_ABFRAGEN im Agenten passen
const RADII = [5, 10, 20, 30, 50, 100, 150, 200];
const YAML_HEADER = `# Watchlist für den Kleinanzeigen-Agenten.
# Am bequemsten über die Weboberfläche pflegen; direktes Bearbeiten geht auch.
#
# gebiet:  umkreis              – nur im Umkreis um die PLZ
#          umkreis_plus_versand – Umkreis + zusätzlich bundesweit mit Versand
#          bundesweit           – ganz Deutschland, ohne Einschränkung
# hoechstpreis: Anzeigen ohne Preisangabe ("VB") werden immer gemeldet.
# ausschluss:   Wörter, bei denen eine Anzeige ignoriert wird (im Titel, Groß/klein egal).
# titel_muss_begriff_enthalten: true = nur Anzeigen, deren Titel einen der Suchbegriffe
#               enthält (Leerzeichen/Bindestriche egal). false = alles, was Kleinanzeigen liefert.

`;

const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, props = {}, ...children) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else n.setAttribute(k, v);
  }
  for (const c of children) if (c != null) n.append(c);
  return n;
};

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* privat-Modus */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* egal */ } },
};

let token = store.get(LS_TOKEN) || "";
let repo = store.get(LS_REPO) || DEFAULT_REPO;
let watch = null;      // aktuelles Objekt (bearbeitet)
let watchSaved = "";   // JSON-Snapshot des gespeicherten Stands
let watchSha = null;
let openKeys = new Set();

/* ---------- Meldungen ---------- */
function msg(text, kind = "ok", sticky = false) {
  const m = $("#msg");
  m.textContent = text;
  m.className = "msg " + kind;
  m.hidden = false;
  m.scrollIntoView({ block: "nearest" });
  clearTimeout(msg.t);
  if (!sticky) msg.t = setTimeout(() => (m.hidden = true), 6000);
}

/* ---------- GitHub-API ---------- */
class ApiError extends Error {
  constructor(status, body) { super(`HTTP ${status}`); this.status = status; this.body = body; }
}

async function gh(path, opts = {}) {
  const headers = {
    Authorization: "Bearer " + token,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (opts.body) headers["Content-Type"] = "application/json";
  let r;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    r = await fetch("https://api.github.com" + path, { ...opts, headers, cache: "no-store", signal: ctrl.signal });
  } catch (e) {
    throw new Error(e.name === "AbortError"
      ? "GitHub antwortet nicht (Zeitüberschreitung nach 20 s)."
      : `Keine Verbindung zu GitHub (${e.message}). Bist du online?`);
  } finally {
    clearTimeout(timer);
  }
  if (!r.ok) throw new ApiError(r.status, await r.text());
  return r.status === 204 ? null : r.json();
}

function explain(e, what) {
  if (!(e instanceof ApiError)) return `${what}: ${e.message}`;
  switch (e.status) {
    case 401: return `${what}: Token ungültig oder abgelaufen. Bitte unter ⚙ einen neuen Token eintragen.`;
    case 403: return `${what}: Der Token hat dafür keine Berechtigung (nötig: Contents und Actions jeweils „Read and write“).`;
    case 404: return `${what}: Repository oder Datei nicht gefunden – stimmt „${repo}“ und darf der Token auf dieses Repo zugreifen?`;
    case 409: return `${what}: Die Datei wurde zwischenzeitlich geändert. Bitte Seite neu laden und Änderung wiederholen.`;
    case 422: return `${what}: GitHub hat die Anfrage abgelehnt (${e.body.slice(0, 160)}).`;
    default: return `${what}: Fehler ${e.status}.`;
  }
}

function b64decode(b64) {
  const bin = atob(b64.replace(/\s/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function readFile(name) {
  const d = await gh(`/repos/${repo}/contents/${encodeURIComponent(name)}?ref=${BRANCH}`);
  if (d.content === "" && d.size > 0) {
    // > 1 MB: Inhalt über Blob-API
    const blob = await gh(`/repos/${repo}/git/blobs/${d.sha}`);
    return { text: b64decode(blob.content), sha: d.sha };
  }
  return { text: b64decode(d.content), sha: d.sha };
}

/* ---------- Watchlist-Modell ---------- */
function normalizeProduct(p) {
  return {
    name: String(p.name ?? "").trim(),
    begriffe: (p.begriffe || []).map(String),
    hoechstpreis: p.hoechstpreis === "" || p.hoechstpreis == null ? null : Number(p.hoechstpreis),
    umkreis_km: Number(p.umkreis_km || 50),
    gebiet: p.gebiet || "umkreis",
    ausschluss: (p.ausschluss || []).map(String),
    titel_muss_begriff_enthalten: p.titel_muss_begriff_enthalten !== false,
    aktiv: p.aktiv !== false,
  };
}
function normalizeWatch(d) {
  d = d || {};
  return {
    einstellungen: { plz: String(d.einstellungen?.plz ?? "") },
    produkte: (d.produkte || []).map(normalizeProduct),
  };
}
const snapshot = () => JSON.stringify(watch);
const dirty = () => watch && snapshot() !== watchSaved;
const queriesOf = (p) => p.aktiv ? p.begriffe.length * (p.gebiet === "umkreis_plus_versand" ? 2 : 1) : 0;

function validate() {
  const errs = [];
  if (!/^\d{5}$/.test(watch.einstellungen.plz)) errs.push("PLZ muss 5 Ziffern haben.");
  const names = new Set();
  watch.produkte.forEach((p, i) => {
    const n = p.name || `Produkt ${i + 1}`;
    if (!p.name) errs.push(`${n}: Name fehlt.`);
    const key = p.name.toLowerCase();
    if (names.has(key)) errs.push(`${n}: Name doppelt.`);
    names.add(key);
    if (!p.begriffe.length) errs.push(`${n}: mindestens ein Suchbegriff nötig.`);
    if (p.hoechstpreis != null && !(p.hoechstpreis >= 0)) errs.push(`${n}: Höchstpreis ungültig.`);
  });
  return errs;
}

function toYaml() {
  const data = {
    einstellungen: { plz: watch.einstellungen.plz },
    produkte: watch.produkte.map((p) => {
      const o = { name: p.name, begriffe: p.begriffe };
      if (p.hoechstpreis != null) o.hoechstpreis = p.hoechstpreis;
      Object.assign(o, {
        umkreis_km: p.umkreis_km, gebiet: p.gebiet, ausschluss: p.ausschluss,
        titel_muss_begriff_enthalten: p.titel_muss_begriff_enthalten, aktiv: p.aktiv,
      });
      return o;
    }),
  };
  return YAML_HEADER + jsyaml.dump(data, { lineWidth: -1, noRefs: true, quotingType: '"' });
}

/* ---------- Laden / Speichern ---------- */
async function loadWatch() {
  const f = await readFile("watchlist.yaml");
  watch = normalizeWatch(jsyaml.load(f.text));
  watchSha = f.sha;
  watchSaved = snapshot();
}

async function saveWatch() {
  const errs = validate();
  if (errs.length) { msg("Nicht gespeichert:\n" + errs.join("\n"), "err", true); return; }
  const btn = $("#btn-save");
  btn.disabled = true;
  try {
    const res = await gh(`/repos/${repo}/contents/watchlist.yaml`, {
      method: "PUT",
      body: JSON.stringify({
        message: "Watchlist über Weboberfläche geändert",
        content: b64encode(toYaml()),
        sha: watchSha,
        branch: BRANCH,
      }),
    });
    watchSha = res.content.sha;
    watchSaved = snapshot();
    msg("Gespeichert. Gilt ab dem nächsten Suchlauf.");
  } catch (e) {
    msg(explain(e, "Speichern fehlgeschlagen"), "err", true);
  } finally {
    btn.disabled = false;
    updateSavebar();
  }
}

async function runWorkflow(testpush = false) {
  try {
    await gh(`/repos/${repo}/actions/workflows/${WORKFLOW}/dispatches`, {
      method: "POST",
      body: JSON.stringify({ ref: BRANCH, inputs: { testpush: testpush ? "true" : "false" } }),
    });
    msg(testpush
      ? "Test-Push angefordert – kommt in ca. 30 Sekunden."
      : "Suchlauf gestartet. Neue Treffer kommen in 1–2 Minuten aufs Handy; die Treffer-Liste aktualisiert sich danach beim Neuladen.");
  } catch (e) {
    msg(explain(e, "Start fehlgeschlagen"), "err", true);
  }
}

/* ---------- Darstellung: Watchlist ---------- */
function updateSavebar() {
  $("#savebar").hidden = !dirty();
  if (!watch) return;
  const total = watch.produkte.reduce((s, p) => s + queriesOf(p), 0);
  $("#budget").textContent = total <= MAX_QUERIES
    ? `${total} Suchanfragen pro Lauf (max. ${MAX_QUERIES}) – alles wird bei jedem Lauf gesucht.`
    : `${total} Suchanfragen – mehr als ${MAX_QUERIES} pro Lauf. Der Agent verteilt sie auf mehrere Läufe; jeder Begriff kommt dann nur etwa alle ${Math.ceil(total / MAX_QUERIES) * 30} Minuten dran.`;
}

function chipList(container, list, onChange) {
  container.replaceChildren();
  if (!list.length) container.append(el("span", { class: "empty", text: "keine" }));
  list.forEach((w, i) => {
    const x = el("button", { type: "button", "aria-label": `„${w}“ entfernen`, text: "×" });
    x.addEventListener("click", () => { list.splice(i, 1); onChange(); });
    container.append(el("span", { class: "chip" }, el("span", { text: w }), x));
  });
}

function wireAdd(input, button, list, onChange) {
  const add = () => {
    const parts = input.value.split(",").map((s) => s.trim()).filter(Boolean);
    for (const v of parts) if (!list.some((x) => x.toLowerCase() === v.toLowerCase())) list.push(v);
    input.value = "";
    if (parts.length) onChange();
  };
  button.addEventListener("click", add);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); add(); } });
}

function renderProducts() {
  const wrap = $("#products");
  wrap.replaceChildren();
  $("#in-plz").value = watch.einstellungen.plz;
  watch.produkte.forEach((p, idx) => {
    const node = $("#tpl-product").content.firstElementChild.cloneNode(true);
    const key = `${idx}`;
    if (openKeys.has(key)) node.open = true;
    node.addEventListener("toggle", () => node.open ? openKeys.add(key) : openKeys.delete(key));

    const refreshHead = () => {
      $(".p-name", node).textContent = p.name || "(ohne Namen)";
      const area = { umkreis: `${p.umkreis_km} km`, umkreis_plus_versand: `${p.umkreis_km} km + Versand`, bundesweit: "bundesweit" }[p.gebiet];
      $(".p-meta", node).textContent =
        `${p.hoechstpreis != null ? "≤ " + p.hoechstpreis + " €" : "jeder Preis"} · ${area} · ${p.begriffe.length} Begriffe`;
      node.classList.toggle("inactive", !p.aktiv);
      $(".f-radius", node).disabled = p.gebiet === "bundesweit";
      updateSavebar();
    };
    const fName = $(".f-name", node), fActive = $(".f-active", node), fPrice = $(".f-price", node);
    const fArea = $(".f-area", node), fRadius = $(".f-radius", node), fTitle = $(".f-title", node);
    fName.value = p.name;
    fActive.checked = p.aktiv;
    fPrice.value = p.hoechstpreis ?? "";
    fArea.value = p.gebiet;
    if (!RADII.includes(p.umkreis_km)) fRadius.append(el("option", { text: String(p.umkreis_km) }));
    fRadius.value = String(p.umkreis_km);
    fTitle.checked = p.titel_muss_begriff_enthalten;

    fName.addEventListener("input", () => { p.name = fName.value.trim(); refreshHead(); });
    fActive.addEventListener("change", () => { p.aktiv = fActive.checked; refreshHead(); });
    fPrice.addEventListener("input", () => { p.hoechstpreis = fPrice.value === "" ? null : Math.round(Number(fPrice.value)); refreshHead(); });
    fArea.addEventListener("change", () => { p.gebiet = fArea.value; refreshHead(); });
    fRadius.addEventListener("change", () => { p.umkreis_km = Number(fRadius.value); refreshHead(); });
    fTitle.addEventListener("change", () => { p.titel_muss_begriff_enthalten = fTitle.checked; refreshHead(); });

    const terms = () => { chipList($(".f-terms", node), p.begriffe, terms); refreshHead(); };
    const excl = () => { chipList($(".f-excl", node), p.ausschluss, excl); refreshHead(); };
    wireAdd($(".f-term-new", node), $(".f-term-add", node), p.begriffe, terms);
    wireAdd($(".f-excl-new", node), $(".f-excl-add", node), p.ausschluss, excl);
    terms(); excl();

    $(".f-delete", node).addEventListener("click", () => {
      if (!confirm(`„${p.name || "Produkt"}“ wirklich löschen? (Erst mit „Speichern“ endgültig.)`)) return;
      watch.produkte.splice(idx, 1);
      openKeys = new Set();
      renderProducts();
    });
    wrap.append(node);
  });
  updateSavebar();
}

/* ---------- Darstellung: Treffer ---------- */
const safeUrl = (u, prefix) => (typeof u === "string" && u.startsWith(prefix) ? u : null);
const fmtTime = (iso) => {
  const d = new Date(iso);
  return isNaN(d) ? "" : d.toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" });
};

async function loadHits() {
  const box = $("#hits");
  box.replaceChildren(el("p", { class: "hint", text: "Lade …" }));
  let state;
  try {
    state = JSON.parse((await readFile("state.json")).text);
  } catch (e) {
    box.replaceChildren(el("p", { class: "hint", text: e.status === 404 ? "Noch kein Suchlauf gelaufen." : explain(e, "Treffer laden") }));
    return;
  }
  const lr = state.letzter_lauf || {};
  $("#last-run").textContent = lr.zeit
    ? `Letzter Lauf: ${fmtTime(lr.zeit)} · ${lr.abfragen}/${lr.abfragen_gesamt} Abfragen · ${lr.neue_treffer} neue Treffer` +
      (lr.fehler?.length ? ` · ⚠ ${lr.fehler.join(" | ")}` : "")
    : "";
  box.replaceChildren();
  const prods = Object.values(state.produkte || {});
  if (!prods.length) box.append(el("p", { class: "hint", text: "Noch keine Treffer." }));
  for (const p of prods) {
    const card = el("div", { class: "card" }, el("h2", { text: p.name }));
    const hits = p.letzte_treffer || [];
    if (!hits.length) card.append(el("p", { class: "empty", text: "Noch keine passenden Anzeigen." }));
    for (const h of hits) {
      const href = safeUrl(h.url, "https://www.kleinanzeigen.de/");
      const img = safeUrl(h.bild, "https://img.kleinanzeigen.de/");
      const a = el(href ? "a" : "div", href ? { class: "hit", href, target: "_blank", rel: "noopener noreferrer" } : { class: "hit" });
      a.append(img ? el("img", { src: img, alt: "", loading: "lazy", referrerpolicy: "no-referrer" }) : el("div", { class: "noimg" }));
      const t = el("div", { class: "t", text: h.titel });
      if (h.bestand) t.append(el("span", { class: "badge", text: "Bestand" }));
      a.append(el("div", {},
        t,
        el("div", { class: "s", text: [h.preis || "ohne Preis", h.ort + (h.entfernung_km != null ? ` (${h.entfernung_km} km)` : ""), h.datum].filter(Boolean).join(" · ") }),
        el("div", { class: "s", text: "gefunden " + fmtTime(h.gefunden) })));
      card.append(a);
    }
    box.append(card);
  }
}

/* ---------- Ablauf ---------- */
function showTab(name) {
  $("#tab-watch").setAttribute("aria-selected", name === "watch");
  $("#tab-hits").setAttribute("aria-selected", name === "hits");
  $("#view-watch").hidden = name !== "watch";
  $("#view-hits").hidden = name !== "hits";
  if (name === "hits") loadHits();
}

function showSetup(show) {
  $("#setup").hidden = !show;
  $(".tabs").hidden = show;
  $("#btn-run").disabled = show;
  if (show) {
    $("#view-watch").hidden = $("#view-hits").hidden = true;
    $("#in-token").value = token;
    $("#in-repo").value = repo;
  }
}

async function start(fromButton = false) {
  $("#lnk-actions").href = `https://github.com/${repo}/actions`;
  if (!token) {
    showSetup(true);
    if (fromButton) msg("Bitte zuerst den Token in das Feld „Token“ einfügen.", "err", true);
    return;
  }
  const btn = $("#btn-save-token");
  btn.disabled = true;
  msg(`Lade Watchlist aus ${repo} …`, "warn", true);
  try {
    await loadWatch();
  } catch (e) {
    msg(explain(e, "Watchlist laden"), "err", true);
    showSetup(true);
    return;
  } finally {
    btn.disabled = false;
  }
  $("#msg").hidden = true;
  showSetup(false);
  renderProducts();
  showTab("watch");
}

$("#btn-save-token").addEventListener("click", () => {
  token = $("#in-token").value.trim();
  repo = $("#in-repo").value.trim().replace(/^https:\/\/github\.com\//, "").replace(/\/$/, "") || DEFAULT_REPO;
  store.set(LS_TOKEN, token);
  store.set(LS_REPO, repo);
  start(true);
});
$("#in-token").addEventListener("input", (e) => {
  const n = e.target.value.trim().length;
  $("#token-info").textContent = n
    ? `Token: ${n} Zeichen${/^github_pat_/.test(e.target.value.trim()) ? "" : " – sollte mit „github_pat_“ beginnen"}`
    : "";
});
window.addEventListener("error", (e) => msg("Interner Fehler: " + e.message, "err", true));
window.addEventListener("unhandledrejection", (e) => msg("Interner Fehler: " + (e.reason?.message || e.reason), "err", true));
$("#btn-forget").addEventListener("click", () => {
  store.del(LS_TOKEN);
  token = "";
  $("#in-token").value = "";
  msg("Token aus diesem Browser gelöscht.");
});
$("#tab-watch").addEventListener("click", () => showTab("watch"));
$("#tab-hits").addEventListener("click", () => showTab("hits"));
$("#in-plz").addEventListener("input", (e) => { watch.einstellungen.plz = e.target.value.trim(); updateSavebar(); });
$("#btn-add").addEventListener("click", () => {
  watch.produkte.push(normalizeProduct({ name: "", begriffe: [], umkreis_km: 50, gebiet: "umkreis" }));
  openKeys.add(String(watch.produkte.length - 1));
  renderProducts();
  const last = $("#products").lastElementChild;
  last.scrollIntoView({ behavior: "smooth", block: "start" });
  $(".f-name", last).focus();
});
$("#btn-save").addEventListener("click", saveWatch);
$("#btn-discard").addEventListener("click", () => {
  watch = JSON.parse(watchSaved);
  renderProducts();
});
$("#btn-run").addEventListener("click", () => {
  if (dirty() && !confirm("Es gibt ungespeicherte Änderungen. Trotzdem mit dem gespeicherten Stand suchen?")) return;
  runWorkflow(false);
});
$("#btn-settings").addEventListener("click", () => $("#dlg-settings").showModal());
$("#btn-edit-token").addEventListener("click", () => { $("#dlg-settings").close(); showSetup(true); });
$("#btn-testpush").addEventListener("click", () => { $("#dlg-settings").close(); runWorkflow(true); });
window.addEventListener("beforeunload", (e) => { if (dirty()) { e.preventDefault(); e.returnValue = ""; } });

start();
