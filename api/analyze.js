// ИнформирAI се — AI анализ ("Свържи картинката" и "Кой е това?")
// Vercel serverless функция. Променливи в Vercel:
//   SUPABASE_URL, SUPABASE_ANON_KEY, GEMINI_API_KEY
//   SUPABASE_SERVICE_KEY (по желание - за кеширане на анализите)
//   GEMINI_MODEL (по желание)

const SB = (process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "").replace(/\/rest\/v1$/, "").replace(/\/+$/, "");
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

// Стриймва отговора: onText(парче) се вика при всяко ново парче текст.
let thinkingOk = true;   // ако моделът не поддържа thinkingLevel, спираме да го пращаме
async function gemini(prompt, grounded, budgetMs, onText) {
  const deadline = Date.now() + budgetMs;
  let lastErr = "";
  for (const model of MODELS) {
    const left = deadline - Date.now();
    if (left < 5000) break;
    const body = {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.4, ...(thinkingOk ? { thinkingConfig: { thinkingLevel: "low" } } : {}) },
    };
    if (grounded) body.tools = [{ google_search: {} }];
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${GKEY}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(left) }
    );
    if (r.status === 404) { lastErr = `${model} не е наличен`; continue; }
    if (!r.ok) {
      const t = (await r.text()).slice(0, 300);
      if (r.status === 400 && thinkingOk && /think/i.test(t)) { thinkingOk = false; return gemini(prompt, grounded, deadline - Date.now(), onText); }
      lastErr = `${r.status} ${t}`;
      if (r.status === 429) break;
      continue;
    }
    // четене на SSE потока
    let text = "", web = [], buf = "";
    const dec = new TextDecoder();
    for await (const chunk of r.body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line.startsWith("data:")) continue;
        let d; try { d = JSON.parse(line.slice(5)); } catch { continue; }
        const cand = d.candidates?.[0] || {};
        const piece = (cand.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || "").join("");
        if (piece) { text += piece; onText(piece); }
        const chunks = cand.groundingMetadata?.groundingChunks;
        if (chunks) web = chunks.map((c) => c.web).filter(Boolean).map((w) => ({ title: w.title, url: w.uri }));
      }
    }
    if (text) return { text, web, model };
    lastErr = "празен отговор";
  }
  throw new Error(lastErr || "AI не отговори навреме");
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

const STYLE = `Пиши на български в сериозен, неутрален и информативен тон - като аналитичен бриф или енциклопедична справка.
Без обръщения към читателя, без въведения и заключителни фрази, без емоционални думи, утешения или риторични въпроси.
Само факти: дати, имена, институции, числа, причинно-следствени връзки.
Използвай кратки заглавия с "### ", списъци с "- " и **удебеляване** за ключови имена и години.
Когато се позоваваш на статия от архива, сложи номера ѝ в квадратни скоби, напр. [2].
Не измисляй факти. Ако нещо е непотвърдено или спорно, отбележи го изрично. Максимум ~450 думи.`;

async function articlePrompt(id) {
  const [a] = await sb(`articles?select=${FIELDS}&id=eq.${encodeURIComponent(id)}`);
  if (!a) throw new Error("Няма такава статия");
  // две отделни заявки (по хора и по теми), за да не чупят скоби/запетаи в имената филтъра
  const byField = async (field, vals) => vals?.length
    ? sb(`articles?select=${FIELDS}&id=neq.${a.id}&${field}=ov.${encodeURIComponent(pgArray(vals))}&order=published_at.desc&limit=20`).catch(() => [])
    : [];
  const [p, t] = await Promise.all([byField("people", a.people), byField("tags", a.tags)]);
  const seen = new Set();
  const related = [...p, ...t].filter((r) => !seen.has(r.id) && seen.add(r.id))
    .sort((x, y) => new Date(y.published_at) - new Date(x.published_at)).slice(0, 25);
  const prompt = `Изготви справка за контекста и предисторията на следната новина.

НОВИНАТА (${fmtDate(a.published_at)}, ${a.source_name}):
${a.title}${a.title_bg ? `\n(превод: ${a.title_bg})` : ""}
${a.summary || ""}
Хора: ${(a.people || []).join(", ") || "-"} · Теми: ${(a.tags || []).join(", ") || "-"}

СВЪРЗАНИ СТАТИИ ОТ АРХИВА:
${related.length ? listForPrompt(related) : "(все още няма)"}

Структура на отговора:
### Накратко
2-3 изречения за същността на събитието.
### Предистория
Ключовите по-стари събития, довели дотук, хронологично и с години.
### Участници
Основните участници и техните позиции и интереси.
### Връзка с други новини
Как се свързва със статиите от архива (с номера).
### Какво предстои
2-3 предстоящи стъпки, срокове или отворени въпроси.

${STYLE}`;
  return { prompt, related };
}

async function personPrompt(name) {
  const rows = await sb(`articles?select=${FIELDS}&people=cs.${encodeURIComponent(pgArray([name]))}` +
    `&order=published_at.desc&limit=30`);
  const prompt = `Изготви кратка справка за "${name}" - кой е и защо е значим в новините.

СТАТИИ ОТ АРХИВА, В КОИТО СЕ СПОМЕНАВА:
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

// Отговорът е поток от редове JSON: {"t":"парче текст"} ... и накрая {"done":true, ...}
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("X-Accel-Buffering", "no");
  const send = (o) => res.write(JSON.stringify(o) + "\n");
  try {
    if (!SB || !ANON || !GKEY) throw new Error("Липсват настройки в Vercel (SUPABASE_URL, SUPABASE_ANON_KEY, GEMINI_API_KEY)");
    const q = req.method === "POST" ? (typeof req.body === "string" ? JSON.parse(req.body) : req.body) : req.query;
    const mode = q.mode === "person" ? "person" : "article";
    const subject = String(mode === "person" ? q.name : q.id || "").slice(0, 200);
    if (!subject) throw new Error("Липсва статия или име");
    const key = `v2:${mode}:${subject}`;   // v2 = сериозен тон

    if (SERVICE && !q.refresh) {
      const [hit] = await sb(`analyses?select=content,created_at&key=eq.${encodeURIComponent(key)}`, SERVICE);
      if (hit && Date.now() - new Date(hit.created_at).getTime() < TTL[mode]) {
        send({ t: hit.content.text });
        send({ done: true, ...hit.content, text: undefined, cached: true });
        return res.end();
      }
    }

    const { prompt, related } = mode === "person" ? await personPrompt(subject) : await articlePrompt(subject);
    const rel = related.map(({ id, url, source_name, title, title_bg, published_at }) =>
      ({ id, url, source_name, title: title_bg || title, published_at }));
    send({ status: "searching", related: rel });
    let out, started = false;
    const onText = (t) => { started = true; send({ t }); };
    try {
      out = await gemini(prompt, true, 150000, onText);      // с търсене в Google за по-стар контекст
    } catch (e) {
      if (started) throw e;                                   // вече е писал - не започваме наново
      send({ status: "fallback" });
      out = await gemini(prompt, false, 90000, onText);       // без търсене (по-бързо / при изчерпан лимит)
    }

    const content = {
      text: out.text,
      web: out.web.slice(0, 8),
      related: rel,
      generated_at: new Date().toISOString(),
    };
    if (SERVICE) {
      await sb("analyses?on_conflict=key", SERVICE, {
        method: "POST", body: JSON.stringify({ key, content, created_at: content.generated_at }),
        headers: { Prefer: "resolution=merge-duplicates" },
      }).catch(() => {});
    }
    send({ done: true, web: content.web, related: content.related });
    res.end();
  } catch (e) {
    const msg = String(e.message || e);
    const friendly = msg.includes("429") ? "Дневният безплатен лимит на Gemini е изчерпан. Опитай пак по-късно."
      : /timeout|aborted/i.test(msg) ? "AI се забави твърде много. Опитай пак след малко." : msg;
    send({ error: friendly });
    res.end();
  }
}
