import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const cfg = window.APP_CONFIG || {};
const db = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, { auth: { persistSession: false } });
const view = document.getElementById("view");
const PAGE = 25;
const FIELDS = "id,url,source,source_name,lang,title,summary,title_bg,summary_bg,image_url,published_at,categories,people,tags";

let CATS = [], SOURCES = [];

// ---------- настройки (пазят се на телефона) ----------
const store = {
  get(k, d) { try { const v = localStorage.getItem("iai:" + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("iai:" + k, JSON.stringify(v)); } catch {} },
};
const prefs = {
  get lang() { return store.get("lang", "bg"); },            // "bg" = превод, "orig" = оригинал
  set lang(v) { store.set("lang", v); },
  get region() { return store.get("region", "bg"); },        // "bg", "world" или "all"
  set region(v) { store.set("region", v); },
  get off() { return store.get("offSources", []); },
  set off(v) { store.set("offSources", v); },
};
// тема: "auto" (според телефона), "light" или "dark"
const darkMQ = window.matchMedia("(prefers-color-scheme: dark)");
function applyTheme(t) {
  if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
  const dark = t === "dark" || (t !== "light" && darkMQ.matches);
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => { m.content = dark ? "#151412" : "#f8f4ec"; m.removeAttribute("media"); });
}
function setTheme(t) { store.set("theme", t); applyTheme(t); }
applyTheme(store.get("theme", "auto"));
darkMQ.addEventListener?.("change", () => applyTheme(store.get("theme", "auto")));
document.getElementById("btn-theme").onclick = () => {
  const t = store.get("theme", "auto");
  const isDark = t === "dark" || (t !== "light" && darkMQ.matches);
  setTheme(isDark ? "light" : "dark");
  if (location.hash === "#/settings") pageSettings();
};

const flipped = new Set();   // статии, при които е натиснат "превод/оригинал"

// ---------- помощни ----------
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const enc = encodeURIComponent;
const catName = (id) => CATS.find((c) => c.id === id)?.name || id;

function ago(iso) {
  const d = new Date(iso), s = (Date.now() - d) / 1000;
  if (s < 60) return "току-що";
  if (s < 3600) return `преди ${Math.floor(s / 60)} мин`;
  if (s < 86400) return `преди ${Math.floor(s / 3600)} ч`;
  if (s < 172800) return "вчера";
  return d.toLocaleDateString("bg-BG", { day: "numeric", month: "short", year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
}

function showBg(a) {
  if (a.lang === "bg" || !a.title_bg) return false;
  const wantBg = prefs.lang === "bg";
  return flipped.has(a.id) ? !wantBg : wantBg;
}
const T = (a) => (showBg(a) ? a.title_bg : a.title);
const S = (a) => (showBg(a) ? a.summary_bg || a.summary : a.summary);

function activeSources(q) {
  const off = prefs.off;
  if (!off.length) return q;
  const on = SOURCES.filter((s) => !off.includes(s.id)).map((s) => s.id);
  return q.in("source", on.length ? on : ["__none__"]);
}

function card(a, lead = false) {
  const cat = (a.categories || [])[0];
  const people = (a.people || []).slice(0, 4).map((p) => `<span data-go="#/p/${enc(p)}">${esc(p)}</span>`).join(", ");
  return `<a class="card${lead && a.image_url ? " lead" : ""}" href="#/a/${a.id}">
    <div class="row"><div class="body">
      <div class="kicker">${cat ? `<span class="cat" data-go="#/c/${enc(cat)}">${esc(catName(cat))}</span>` : ""}<span class="src">${esc(a.source_name)}</span><span>${ago(a.published_at)}</span>${a.lang !== "bg" ? `<span class="lang-badge">${showBg(a) ? "превод" : "EN"}</span>` : ""}</div>
      <h2>${esc(T(a))}</h2>
      ${S(a) ? `<p class="sum">${esc(S(a))}</p>` : ""}
      ${people ? `<div class="people">${people}</div>` : ""}
    </div>${a.image_url ? `<img class="thumb" loading="lazy" src="${esc(a.image_url)}" alt="" onerror="this.remove()">` : ""}</div>
  </a>`;
}

// чиповете вътре в картата водят на друго място
view.addEventListener("click", (e) => {
  const go = e.target.closest("[data-go]");
  if (go) { e.preventDefault(); e.stopPropagation(); location.hash = go.dataset.go; }
});

const loading = (t = "Зареждам…") => `<div class="loading"><div class="spinner"></div>${esc(t)}</div>`;
const errBox = (e) => `<div class="error">Нещо се обърка: ${esc(e.message || e)}</div>`;

// списък със "Зареди още"
async function feed(container, build, emptyText = "Още няма статии тук.", withLead = false) {
  let page = 0;
  const list = document.createElement("div");
  const more = document.createElement("button");
  more.className = "btn ghost full"; more.id = "more"; more.textContent = "Зареди още";
  container.append(list, more);
  async function load() {
    more.disabled = true; more.textContent = "Зареждам…";
    try {
      const { data, error } = await build(activeSources(db.from("articles").select(FIELDS)))
        .order("published_at", { ascending: false }).range(page * PAGE, page * PAGE + PAGE - 1);
      if (error) throw error;
      if (!data.length && page === 0) list.innerHTML = `<div class="empty">${esc(emptyText)}</div>`;
      list.insertAdjacentHTML("beforeend", data.map((a, i) => card(a, withLead && page === 0 && i === 0)).join(""));
      page++;
      more.classList.toggle("hidden", data.length < PAGE);
    } catch (e) { list.insertAdjacentHTML("beforeend", errBox(e)); more.classList.add("hidden"); }
    more.disabled = false; more.textContent = "Зареди още";
  }
  more.onclick = load;
  await load();
}

// ---------- мини markdown за AI отговорите ----------
function md(text, related) {
  const inline = (s) => esc(s)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\[(\d{1,2})\]/g, (m, n) => {
      const r = related?.[n - 1];
      return r ? `<a class="ref" href="#/a/${r.id}">[${n}]</a>` : m;
    })
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  let html = "", list = null;
  const close = () => { if (list) { html += `</${list}>`; list = null; } };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) { close(); continue; }
    let m;
    if ((m = line.match(/^#{1,4}\s+(.*)/))) { close(); html += `<h3>${inline(m[1])}</h3>`; }
    else if ((m = line.match(/^[-*•]\s+(.*)/))) { if (list !== "ul") { close(); html += "<ul>"; list = "ul"; } html += `<li>${inline(m[1])}</li>`; }
    else if ((m = line.match(/^\d+[.)]\s+(.*)/))) { if (list !== "ol") { close(); html += "<ol>"; list = "ol"; } html += `<li>${inline(m[1])}</li>`; }
    else { close(); html += `<p>${inline(line)}</p>`; }
  }
  close();
  return html;
}

async function aiPanel(box, params, label) {
  box.innerHTML = `<div class="ai">${loading(label)}</div>`;
  try {
    const r = await fetch("/api/analyze?" + new URLSearchParams(params));
    let data;
    try { data = await r.json(); }
    catch { throw new Error(r.status === 504 ? "AI се забави твърде много. Опитай пак след малко." : `Сървърът върна грешка (${r.status}). Опитай пак.`); }
    if (!r.ok) throw new Error(data.error || r.status);
    const web = (data.web || []).map((w) => `<a href="${esc(w.url)}" target="_blank" rel="noopener">${esc(w.title || "източник")}</a>`).join(" · ");
    box.innerHTML = `<div class="ai">${md(data.text, data.related)}
      <div class="foot">Генерирано от AI (Gemini) — може да съдържа неточности.${web ? `<br>Източници от мрежата: ${web}` : ""}
      ${data.cached ? ` <a href="#" id="ai-refresh">Обнови анализа</a>` : ""}</div></div>`;
    box.querySelector("#ai-refresh")?.addEventListener("click", (e) => { e.preventDefault(); aiPanel(box, { ...params, refresh: 1 }, label); });
  } catch (e) { box.innerHTML = errBox(e); }
}

// ---------- страници ----------
async function pageFeed(cat) {
  const c = CATS.find((x) => x.id === cat);
  const r = prefs.region;
  view.innerHTML = `${c ? `<div class="page-head"><h1>${esc(c.name)}</h1></div>` : ""}
    <div class="region-seg" id="region-seg">
      <button data-v="bg" class="${r === "bg" ? "on" : ""}">България</button>
      <button data-v="world" class="${r === "world" ? "on" : ""}">Светът</button>
      <button data-v="all" class="${r === "all" ? "on" : ""}">Всичко</button>
    </div>`;
  document.getElementById("region-seg").onclick = (e) => {
    if (e.target.dataset.v && e.target.dataset.v !== prefs.region) { prefs.region = e.target.dataset.v; pageFeed(cat); }
  };
  await feed(view, (q) => {
    if (cat) q = q.contains("categories", [cat]);
    if (r !== "all") q = q.eq("region", r);
    return q;
  }, r === "bg" ? "Още няма български новини тук." : undefined, true);
}

async function pageArticle(id) {
  view.innerHTML = loading();
  const { data: a, error } = await db.from("articles").select(FIELDS).eq("id", id).maybeSingle();
  if (error || !a) { view.innerHTML = errBox(error || "Няма такава статия"); return; }
  const canFlip = a.lang !== "bg" && a.title_bg;
  view.innerHTML = `<article class="article">
    <div class="kicker">${(a.categories || []).map((c) => `<a class="cat" href="#/c/${enc(c)}">${esc(catName(c))}</a>`).join("")}<span class="src">${esc(a.source_name)}</span><span>${new Date(a.published_at).toLocaleString("bg-BG", { dateStyle: "medium", timeStyle: "short" })}</span></div>
    <h1>${esc(T(a))}</h1>
    ${S(a) ? `<p class="lead">${esc(S(a))}</p>` : ""}
    ${a.image_url ? `<img class="hero" src="${esc(a.image_url)}" alt="" onerror="this.remove()">` : ""}
    ${a.people?.length ? `<div class="taglist"><b>Хора:</b>${a.people.map((p) => `<a href="#/p/${enc(p)}">${esc(p)}</a>`).join("")}</div>` : ""}
    ${a.tags?.length ? `<div class="taglist"><b>Теми:</b>${a.tags.map((t) => `<a href="#/t/${enc(t)}">${esc(t)}</a>`).join("")}</div>` : ""}
    <div class="btn-row">
      <a class="btn primary" href="${esc(a.url)}" target="_blank" rel="noopener">Прочети в ${esc(a.source_name)} ↗</a>
      ${canFlip ? `<button class="btn ghost" id="flip">${showBg(a) ? "Оригинал (EN)" : "На български"}</button>` : ""}
    </div>
    <button class="btn ghost full" id="ai-btn">Предистория и контекст (AI)</button>
    <div id="ai-box"></div>
    <div class="section-title">Свързани статии от архива</div>
    <div id="related" class="list">${loading()}</div>
  </article>`;
  document.getElementById("flip")?.addEventListener("click", () => {
    flipped.has(a.id) ? flipped.delete(a.id) : flipped.add(a.id);
    pageArticle(id);
  });
  document.getElementById("ai-btn").onclick = (e) => {
    e.target.remove();
    aiPanel(document.getElementById("ai-box"), { mode: "article", id: a.id }, "Събирам предисторията и връзките… (до ~45 сек)");
  };
  const rel = document.getElementById("related");
  const arr = (x) => "{" + x.map((v) => `"${v.replace(/["\\]/g, "\\$&")}"`).join(",") + "}";
  if (!a.people?.length && !a.tags?.length) { rel.innerHTML = `<div class="empty">Няма открити връзки.</div>`; return; }
  const q = (field, vals) => vals?.length
    ? db.from("articles").select(FIELDS).neq("id", a.id).filter(field, "ov", arr(vals)).order("published_at", { ascending: false }).limit(15).then((r) => r.data || [])
    : Promise.resolve([]);
  const seen = new Set();
  const data = (await Promise.all([q("people", a.people), q("tags", a.tags)])).flat()
    .filter((r) => !seen.has(r.id) && seen.add(r.id))
    .sort((x, y) => new Date(y.published_at) - new Date(x.published_at)).slice(0, 15);
  rel.innerHTML = data?.length ? data.map((x) => card(x)).join("") : `<div class="empty">Още няма свързани статии — архивът расте с всеки час.</div>`;
}

async function pagePerson(name) {
  view.innerHTML = `<div class="page-head"><h1>${esc(name)}</h1><p id="p-count"></p></div>
    <button class="btn ghost full" id="ai-btn">Кой е ${esc(name)}? (AI справка)</button>
    <div id="ai-box"></div>
    <div id="co"></div>
    <div class="section-title">Всички статии</div>
    <div id="timeline">${loading()}</div>`;
  document.getElementById("ai-btn").onclick = (e) => {
    e.target.remove();
    aiPanel(document.getElementById("ai-box"), { mode: "person", name }, "AI събира информация…");
  };
  db.rpc("co_people", { person: name, max_rows: 12 }).then(({ data }) => {
    if (data?.length) document.getElementById("co").innerHTML = `<div class="section-title">Често заедно с</div>
      <div class="chips">${data.map((p) => `<a class="chip" href="#/p/${enc(p.name)}">${esc(p.name)} <small>${p.n}</small></a>`).join("")}</div>`;
  });
  const { data, error, count } = await activeSources(db.from("articles").select(FIELDS, { count: "exact" }))
    .contains("people", [name]).order("published_at", { ascending: false }).limit(200);
  const tl = document.getElementById("timeline");
  if (error) { tl.innerHTML = errBox(error); return; }
  document.getElementById("p-count").textContent = `${count ?? data.length} статии в архива`;
  let html = "", month = "";
  for (const a of data) {
    const m = new Date(a.published_at).toLocaleDateString("bg-BG", { month: "long", year: "numeric" });
    if (m !== month) { html += `<div class="month">${esc(m)}</div>`; month = m; }
    html += card(a);
  }
  tl.innerHTML = html || `<div class="empty">Няма статии.</div>`;
}

async function pageTag(tag) {
  view.innerHTML = `<div class="page-head"><h1>${esc(tag)}</h1><p>Всички статии по темата, най-новите първо</p></div>`;
  await feed(view, (q) => q.contains("tags", [tag]));
}

async function pageSearch(q) {
  const input = document.getElementById("search-input");
  input.value = q;
  view.innerHTML = `<div class="page-head"><h1>Търсене: „${esc(q)}“</h1></div>`;
  // всяка дума като начало на дума: "путин тръмп" -> путин:* & тръмп:*
  const terms = q.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, " ").split(/\s+/).filter(Boolean);
  if (!terms.length) return;
  const tsq = terms.map((t) => `${t}:*`).join(" & ");
  await feed(view, (b) => b.textSearch("fts", tsq, { config: "simple" }), "Нищо не намерих. Опитай с по-кратка дума.");
}

function pageSettings() {
  const off = prefs.off;
  view.innerHTML = `<div class="page-head"><h1>Настройки</h1></div>
    <div class="section-title">Изглед</div>
    <div class="list"><div class="setting"><div>Тема<small>„Авто“ следва настройката на телефона</small></div>
      <div class="seg" id="theme-seg"><button data-v="auto">Авто</button><button data-v="light">Светла</button><button data-v="dark">Тъмна</button></div></div></div>
    <div class="section-title">Чужди статии</div>
    <div class="list"><div class="setting"><div>Показвай ги<small>Можеш да превключваш и при всяка статия</small></div>
      <div class="seg" id="lang-seg"><button data-v="bg">На български</button><button data-v="orig">Оригинал</button></div></div></div>
    <div class="section-title">Източници</div>
    <div class="list">${SOURCES.filter((s) => s.enabled !== false).map((s) => `<label class="setting"><div>${esc(s.name)}<small>${s.lang === "bg" ? "български" : "английски"}</small></div>
      <input type="checkbox" class="switch" data-src="${esc(s.id)}" ${off.includes(s.id) ? "" : "checked"}></label>`).join("")}</div>
    <p class="note">Новите статии се събират автоматично на всеки час.<br>За инсталиране: Сподели → „Добави към началния екран“.</p>`;
  const tseg = document.getElementById("theme-seg");
  const tpaint = () => tseg.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.v === store.get("theme", "auto")));
  tpaint();
  tseg.onclick = (e) => { if (e.target.dataset.v) { setTheme(e.target.dataset.v); tpaint(); } };
  const seg = document.getElementById("lang-seg");
  const paint = () => seg.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.v === prefs.lang));
  paint();
  seg.onclick = (e) => { if (e.target.dataset.v) { prefs.lang = e.target.dataset.v; flipped.clear(); paint(); } };
  view.querySelectorAll("[data-src]").forEach((cb) => cb.onchange = () => {
    const s = new Set(prefs.off);
    cb.checked ? s.delete(cb.dataset.src) : s.add(cb.dataset.src);
    prefs.off = [...s];
  });
}

// ---------- навигация ----------
function renderCats(active) {
  const nav = document.getElementById("cats");
  nav.innerHTML = `<a href="#/" class="${active === "" ? "on" : ""}">Всички</a>` +
    CATS.map((c) => `<a href="#/c/${c.id}" class="${active === c.id ? "on" : ""}">${esc(c.name)}</a>`).join("");
  nav.querySelector(".on")?.scrollIntoView({ inline: "center", block: "nearest" });
  updateArrows();
}

// превъртане на категориите с мишка: стрелки + колелцето
const catsNav = document.getElementById("cats");
const arrowL = document.getElementById("cats-left"), arrowR = document.getElementById("cats-right");
function updateArrows() {
  arrowL.classList.toggle("show", catsNav.scrollLeft > 4);
  arrowR.classList.toggle("show", catsNav.scrollLeft + catsNav.clientWidth < catsNav.scrollWidth - 4);
}
arrowL.onclick = () => catsNav.scrollBy({ left: -catsNav.clientWidth * 0.7 });
arrowR.onclick = () => catsNav.scrollBy({ left: catsNav.clientWidth * 0.7 });
catsNav.addEventListener("scroll", updateArrows, { passive: true });
window.addEventListener("resize", updateArrows);
catsNav.addEventListener("wheel", (e) => {
  if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { catsNav.scrollBy({ left: e.deltaY, behavior: "instant" }); e.preventDefault(); }
}, { passive: false });

async function route() {
  const [, kind = "", ...rest] = location.hash.replace(/^#/, "").split("/");
  const arg = decodeURIComponent(rest.join("/"));
  renderCats(kind === "" ? "" : kind === "c" ? arg : null);
  window.scrollTo(0, 0);
  try {
    if (kind === "c") await pageFeed(arg);
    else if (kind === "a") await pageArticle(arg);
    else if (kind === "p") await pagePerson(arg);
    else if (kind === "t") await pageTag(arg);
    else if (kind === "s") await pageSearch(arg);
    else if (kind === "settings") pageSettings();
    else await pageFeed(null);
  } catch (e) { view.innerHTML = errBox(e); }
}

document.getElementById("btn-search").onclick = () => {
  const f = document.getElementById("search-form");
  f.classList.toggle("hidden");
  if (!f.classList.contains("hidden")) document.getElementById("search-input").focus();
};
document.getElementById("search-form").onsubmit = (e) => {
  e.preventDefault();
  const q = document.getElementById("search-input").value.trim();
  if (q) location.hash = `#/s/${enc(q)}`;
};

(async function init() {
  if (!cfg.supabaseUrl) { view.innerHTML = errBox("Липсват настройките за Supabase във Vercel."); return; }
  [CATS, SOURCES] = await Promise.all(["categories", "sources"].map((f) => fetch(`/data/${f}.json`).then((r) => r.json())));
  window.addEventListener("hashchange", route);
  route();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
})();
