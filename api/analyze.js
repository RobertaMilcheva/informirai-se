// ИнформирAI се — AI анализ ("Свържи картинката" и "Кой е това?")
// Vercel serverless функция. Променливи в Vercel:
//   SUPABASE_URL, SUPABASE_ANON_KEY, GEMINI_API_KEY
//   SUPABASE_SERVICE_KEY (по желание - за кеширане на анализите)
//   GEMINI_MODEL (по желание)

const SB = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const ANON = process.env.SUPABASE_ANON_KEY || "";
const SERVICE = process.env.SUPABASE_SERVICE_KEY || "";
const GKEY = process.env.GEMINI_API_KEY || "";
const MODELS = [process.env.GEMINI_MODEL, "gemini-flash-latest", "gemini-flash-lite-latest",
  "gemini-3.5-flash", "gemini-3.5-flash-lite"].filter(Boolean);
const TTL = { article: 7 * 24 * 3600e3, person: 24 * 3600e3 };

function headers(key, extra = {}) {
  const h = { apikey: key, "Content-Type": "application/json", ...extra };
  if (key.startsWith("eyJ")) h.Authorization = `Bearer ${key}`;
  return h;
}

async function sb(path, key = ANON, init = {}) {
  const r = await fetch(`${SB}/rest/v1/${path}`, { ...init, headers: headers(key, init.headers) });
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

const pgArray = (arr) => "{" + arr.map((x) => `"${String(x).replace(/["\\]/g, "\\$&")}"`).join(",") + "}";
const FIELDS = "id,url,source_name,lang,title,summary,title_bg,summary_bg,published_at,people,tags,categories";

async function gemini(prompt, grounded) {
  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.4 },
  };
  if (grounded) body.tools = [{ google_search: {} }];
  let lastErr = "";
  for (const model of MODELS) {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GKEY}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
    );
    if (r.status === 404) { lastErr = `${model} не е наличен`; continue; }
    if (!r.ok) { lastErr = `${r.status} ${(await r.text()).slice(0, 200)}`; if (r.status === 429) break; continue; }
    const data = await r.json();
    const cand = data.candidates?.[0] || {};
    const text = (cand.content?.parts || []).map((p) => p.text || "").join("");
    const web = (cand.groundingMetadata?.groundingChunks || [])
      .map((c) => c.web).filter(Boolean).map((w) => ({ title: w.title, url: w.uri }));
    if (text) return { text, web, model };
    lastErr = "празен отговор";
  }
  throw new Error(lastErr);
}

function fmtDate(iso) {
  return new Date(iso).toLocaleDateString("bg-BG", { day: "numeric", month: "short", year: "numeric" });
}

function listForPrompt(rows) {
  return rows.map((a, i) =>
    `[${i + 1}] ${fmtDate(a.published_at)} · ${a.source_name}: ${a.title_bg || a.title}` +
    (a.summary_bg || a.summary ? ` — ${(a.summary_bg || a.summary).slice(0, 220)}` : "")
  ).join("\n");
}

const STYLE = `Пиши на български, ясно и приятелски, като за умен човек, който просто не е следил темата.
Използвай кратки заглавия с "### ", списъци с "- " и **удебеляване** за ключови имена и години.
Когато се позоваваш на статия от архива, сложи номера ѝ в квадратни скоби, напр. [2].
Не измисляй факти. Ако нещо не е сигурно или е спорно, кажи го. Максимум ~450 думи.`;

async function articlePrompt(id) {
  const [a] = await sb(`articles?select=${FIELDS}&id=eq.${encodeURIComponent(id)}`);
  if (!a) throw new Error("Няма такава статия");
  let related = [];
  const ors = [];
  if (a.people?.length) ors.push(`people.ov.${pgArray(a.people)}`);
  if (a.tags?.length) ors.push(`tags.ov.${pgArray(a.tags)}`);
  if (ors.length) {
    related = await sb(`articles?select=${FIELDS}&id=neq.${a.id}&or=(${encodeURIComponent(ors.join(","))})` +
      `&order=published_at.desc&limit=25`);
  }
  const prompt = `Читателка току-що прочете тази новина и иска да разбере цялата картинка около нея.

НОВИНАТА (${fmtDate(a.published_at)}, ${a.source_name}):
${a.title}${a.title_bg ? `\n(превод: ${a.title_bg})` : ""}
${a.summary || ""}
Хора: ${(a.people || []).join(", ") || "-"} · Теми: ${(a.tags || []).join(", ") || "-"}

СВЪРЗАНИ СТАТИИ ОТ НЕЙНИЯ АРХИВ:
${related.length ? listForPrompt(related) : "(все още няма)"}

Структура на отговора:
### Накратко
2-3 изречения какво всъщност се случва.
### Предистория
Ключовите по-стари събития, довели дотук, хронологично и с години.
### Кой кой е
Основните участници и какво искат.
### Връзка с други новини
Как се свързва със статиите от архива (с номера).
### Какво да следиш
2-3 неща, които предстоят или са важни.

${STYLE}`;
  return { prompt, related };
}

async function personPrompt(name) {
  const rows = await sb(`articles?select=${FIELDS}&people=cs.${encodeURIComponent(pgArray([name]))}` +
    `&order=published_at.desc&limit=30`);
  const prompt = `Читателка цъкна върху името "${name}" в новините и иска да разбере кой е този човек и защо е важен.

СТАТИИ ОТ НЕЙНИЯ АРХИВ, В КОИТО СЕ СПОМЕНАВА:
${rows.length ? listForPrompt(rows) : "(все още няма)"}

Структура на отговора:
### Кой е
Кратко представяне - позиция, държава, с какво е известен/а.
### Ключови моменти
Най-важните събития в кариерата/живота, хронологично с години.
### Защо е в новините сега
По статиите от архива (с номера).
### Връзки
С кои други хора, държави или организации е свързан/а и как.

${STYLE}`;
  return { prompt, related: rows };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  try {
    if (!SB || !ANON || !GKEY) throw new Error("Липсват настройки в Vercel (SUPABASE_URL, SUPABASE_ANON_KEY, GEMINI_API_KEY)");
    const q = req.method === "POST" ? (typeof req.body === "string" ? JSON.parse(req.body) : req.body) : req.query;
    const mode = q.mode === "person" ? "person" : "article";
    const subject = String(mode === "person" ? q.name : q.id || "").slice(0, 200);
    if (!subject) throw new Error("Липсва статия или име");
    const key = `${mode}:${subject}`;

    if (SERVICE && !q.refresh) {
      const [hit] = await sb(`analyses?select=content,created_at&key=eq.${encodeURIComponent(key)}`, SERVICE);
      if (hit && Date.now() - new Date(hit.created_at).getTime() < TTL[mode]) {
        return res.status(200).json({ ...hit.content, cached: true });
      }
    }

    const { prompt, related } = mode === "person" ? await personPrompt(subject) : await articlePrompt(subject);
    let out;
    try { out = await gemini(prompt, true); }        // с търсене в Google за по-стар контекст
    catch { out = await gemini(prompt, false); }      // ако безплатният лимит за търсене е изчерпан

    const content = {
      text: out.text,
      web: out.web.slice(0, 8),
      related: related.map(({ id, url, source_name, title, title_bg, published_at }) =>
        ({ id, url, source_name, title: title_bg || title, published_at })),
      generated_at: new Date().toISOString(),
    };
    if (SERVICE) {
      await sb("analyses?on_conflict=key", SERVICE, {
        method: "POST", body: JSON.stringify({ key, content, created_at: content.generated_at }),
        headers: { Prefer: "resolution=merge-duplicates" },
      }).catch(() => {});
    }
    res.status(200).json(content);
  } catch (e) {
    const msg = String(e.message || e);
    const friendly = msg.includes("429") ? "Дневният безплатен лимит на Gemini е изчерпан. Опитай пак по-късно." : msg;
    res.status(500).json({ error: friendly });
  }
}
