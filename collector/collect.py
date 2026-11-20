"""ИнформирAI се — събирач на новини.

Стъпка 1: чете RSS/началните страници на източниците и записва новите статии.
Стъпка 2: праща необработените статии на Gemini (на партиди) за категории,
          имена на хора, теми и превод на български.

Пуска се от GitHub Actions на всеки час. Нужни променливи на средата:
  SUPABASE_URL, SUPABASE_SERVICE_KEY, GEMINI_API_KEY (по желание GEMINI_MODEL)
"""
import calendar
import html
import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urljoin, urlsplit, urlunsplit, parse_qsl, urlencode

import feedparser
import requests

ROOT = Path(__file__).resolve().parent.parent
SOURCES = json.loads((ROOT / "config" / "sources.json").read_text(encoding="utf-8"))
CATEGORIES = json.loads((ROOT / "config" / "categories.json").read_text(encoding="utf-8"))
CAT_IDS = {c["id"] for c in CATEGORIES}

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")
GEMINI_KEY = os.environ.get("GEMINI_API_KEY", "")
GEMINI_MODELS = [m for m in [
    os.environ.get("GEMINI_MODEL"),
    "gemini-flash-lite-latest",
    "gemini-3.5-flash-lite",
    "gemini-3.1-flash-lite",
    "gemini-flash-latest",
] if m]

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36 InformirAI-se/1.0")
MAX_PER_FEED = 40          # колко най-нови статии да взимаме от всеки фийд
AI_BATCH = 15              # статии на една заявка към Gemini
AI_MAX_PER_RUN = int(os.environ.get("AI_MAX_PER_RUN", "180"))
AI_PAUSE = 6               # секунди между заявките (лимит на безплатния план)

session = requests.Session()
session.headers["User-Agent"] = UA


def log(*a):
    print(*a, flush=True)


# ---------- помощни ----------

TRACKING = {"ref", "utm_source", "utm_medium", "utm_campaign", "utm_content",
            "utm_term", "CMP", "cmp", "at_medium", "at_campaign"}


def clean_url(u: str) -> str:
    s = urlsplit(u.strip())
    q = [(k, v) for k, v in parse_qsl(s.query) if k not in TRACKING]
    return urlunsplit((s.scheme or "https", s.netloc.lower(), s.path, urlencode(q), ""))


def strip_html(t: str | None, limit: int = 700) -> str:
    if not t:
        return ""
    t = re.sub(r"<[^>]+>", " ", t)
    t = html.unescape(t)
    t = " ".join(t.split())
    return t[:limit].rsplit(" ", 1)[0] + "…" if len(t) > limit else t


def to_iso(struct) -> str | None:
    if not struct:
        return None
    ts = calendar.timegm(struct)
    dt = datetime.fromtimestamp(ts, tz=timezone.utc)
    if dt > datetime.now(timezone.utc):
        dt = datetime.now(timezone.utc)
    return dt.isoformat()


def meta(page: str, prop: str) -> str | None:
    m = re.search(r'<meta[^>]+(?:property|name)=["\']%s["\'][^>]+content=["\']([^"\']*)'
                  % re.escape(prop), page, re.I)
    if not m:
        m = re.search(r'<meta[^>]+content=["\']([^"\']*)["\'][^>]+(?:property|name)=["\']%s["\']'
                      % re.escape(prop), page, re.I)
    return html.unescape(m.group(1)).strip() if m else None


# ---------- Supabase (REST) ----------

def sb_headers(extra=None):
    h = {"apikey": SUPABASE_KEY, "Content-Type": "application/json"}
    if SUPABASE_KEY.startswith("eyJ"):          # стар тип JWT ключ
        h["Authorization"] = f"Bearer {SUPABASE_KEY}"
    if extra:
        h.update(extra)
    return h


def sb(method, path, **kw):
    r = session.request(method, f"{SUPABASE_URL}/rest/v1/{path}",
                        headers=sb_headers(kw.pop("headers", None)), timeout=30, **kw)
    if r.status_code >= 300:
        raise RuntimeError(f"Supabase {method} {path}: {r.status_code} {r.text[:300]}")
    return r.json() if r.text else None


def existing_urls(urls):
    found = set()
    urls = list(urls)
    for i in range(0, len(urls), 60):
        chunk = urls[i:i + 60]
        quoted = ",".join('"' + u.replace('"', '\\"') + '"' for u in chunk)
        rows = sb("GET", "articles", params={"select": "url", "url": f"in.({quoted})"})
        found.update(r["url"] for r in rows)
    return found


# ---------- събиране ----------

def fetch_rss(src):
    items = []
    for feed_url in src["feeds"]:
        try:
            r = session.get(feed_url, timeout=25)
            r.raise_for_status()
        except Exception as e:
            log(f"  ! {feed_url}: {e}")
            continue
        parsed = feedparser.parse(r.content)
        for e in parsed.entries[:MAX_PER_FEED]:
            link = e.get("link")
            title = strip_html(e.get("title"), 400)
            if not link or not title:
                continue
            img = None
            for key in ("media_content", "media_thumbnail"):
                if e.get(key):
                    img = e[key][0].get("url")
                    break
            if not img:
                for enc in e.get("enclosures", []):
                    if enc.get("type", "").startswith("image"):
                        img = enc.get("href")
                        break
            if not img:
                m = re.search(r'<img[^>]+src=["\']([^"\']+)', e.get("summary", "") or "")
                img = m.group(1) if m else None
            if img and img.startswith("http://"):
                img = "https://" + img[7:]
            items.append({
                "url": clean_url(link),
                "title": title,
                "summary": strip_html(e.get("summary") or e.get("description")),
                "image_url": img,
                "published_at": to_iso(e.get("published_parsed") or e.get("updated_parsed")),
            })
    return items


def fetch_html(src, known):
    """За сайтове без работещ RSS: взима линковете от началната страница."""
    try:
        r = session.get(src["home"], timeout=25)
        r.raise_for_status()
    except Exception as e:
        log(f"  ! {src['home']}: {e}")
        return []
    pat = re.compile(src["link_pattern"])
    links = []
    for href in re.findall(r'href="([^"]+)"', r.text):
        path = urlsplit(href).path if href.startswith("http") else href
        if pat.match(path):
            u = clean_url(urljoin(src["home"], href))
            if u not in links:
                links.append(u)
    links = links[:MAX_PER_FEED]
    new = [u for u in links if u not in known] if known is not None else links
    try:
        new = [u for u in new if u not in existing_urls(new)]
    except Exception:
        pass
    items = []
    for u in new:
        try:
            p = session.get(u, timeout=25).text
        except Exception:
            continue
        title = meta(p, "og:title")
        if not title:
            continue
        pub = meta(p, "article:published_time")
        try:
            pub = datetime.fromisoformat(pub.replace("Z", "+00:00")).isoformat() if pub else None
        except ValueError:
            pub = None
        items.append({"url": u, "title": strip_html(title, 400),
                      "summary": strip_html(meta(p, "og:description") or meta(p, "description")),
                      "image_url": meta(p, "og:image"), "published_at": pub})
        time.sleep(0.5)
    return items


def collect():
    total = 0
    for src in SOURCES:
        if src.get("enabled") is False:
            continue
        log(f"→ {src['name']}")
        items = fetch_rss(src) if src["type"] == "rss" else fetch_html(src, None)
        if not items:
            log("  (няма статии)")
            continue
        rows, seen = [], set()
        for it in items:
            if it["url"] in seen:
                continue
            seen.add(it["url"])
            row = {**it, "source": src["id"], "source_name": src["name"], "lang": src["lang"]}
            if not row.get("published_at"):
                row.pop("published_at")
            rows.append(row)
        # всички редове в една заявка трябва да имат еднакви колони
        keys = set().union(*rows)
        for row in rows:
            for k in keys:
                row.setdefault(k, None)
            if row["published_at"] is None:
                row["published_at"] = datetime.now(timezone.utc).isoformat()
        res = sb("POST", "articles", params={"on_conflict": "url"}, json=rows,
                 headers={"Prefer": "resolution=ignore-duplicates,return=representation"})
        n = len(res or [])
        total += n
        log(f"  {len(rows)} в източника, {n} нови")
    log(f"Общо нови статии: {total}")


# ---------- AI обработка ----------

PROMPT = """Ти си редактор в българско новинарско приложение. За всяка статия по-долу върни JSON обект с:
- "i": номерът на статията
- "categories": 1 до 3 id-та от този списък (първото е най-важното):
{cats}
- "people": реални хора, споменати или ясно засегнати (максимум 6). Пиши пълното им име НА БЪЛГАРСКИ, в най-разпространената българска форма (напр. "Доналд Тръмп", "Владимир Путин", "Румен Радев"). Без длъжности. Ако няма хора - [].
- "tags": 1 до 4 кратки теми/събития/организации на български, които помагат статията да се свърже с други (напр. "Войната в Украйна", "Еврозона", "НАТО", "Избори в САЩ 2028").
- "title_bg" и "summary_bg": САМО ако езикът е "en" - естествен превод на заглавието и резюме на 1-2 изречения на български. Ако езикът е "bg", върни null.

Отговори само с JSON масив, без друг текст.

Статии:
{items}"""


def gemini(prompt: str, json_mode=True):
    body = {"contents": [{"role": "user", "parts": [{"text": prompt}]}],
            "generationConfig": {"temperature": 0.2}}
    if json_mode:
        body["generationConfig"]["responseMimeType"] = "application/json"
    last = None
    for model in list(GEMINI_MODELS):
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
        for attempt in range(3):
            r = session.post(url, params={"key": GEMINI_KEY}, json=body, timeout=120)
            if r.status_code == 429:
                wait = 20 * (attempt + 1)
                log(f"  лимит на Gemini, чакам {wait}s")
                time.sleep(wait)
                continue
            break
        if r.status_code == 404:          # моделът не съществува -> следващия
            log(f"  моделът {model} не е наличен")
            GEMINI_MODELS.remove(model)
            last = r
            continue
        if r.status_code >= 300:
            raise RuntimeError(f"Gemini {model}: {r.status_code} {r.text[:300]}")
        data = r.json()
        parts = data.get("candidates", [{}])[0].get("content", {}).get("parts", [])
        return "".join(p.get("text", "") for p in parts)
    raise RuntimeError(f"Няма наличен Gemini модел: {last.text[:300] if last is not None else ''}")


KEYWORDS = {
    "geopolitika": ["путин", "тръмп", "украйн", "русия", "нато", "китай", "израел", "иран", "газа",
                    "putin", "trump", "ukrain", "russia", "nato", "china", "israel", "iran", "gaza", "war"],
    "bg-politika": ["парламент", "народно събрание", "министър", "партия", "гербер", "герб", "дпс",
                    "пп-дб", "възраждане", "радев", "избори", "всс", "прокурат"],
    "zakoni": ["закон", "наредба", "кодекс", "регулац", "law", "regulation", "court"],
    "trudovo-pravo": ["заплат", "осигур", "труд", "пенси", "безработ", "wage", "jobs", "worker", "labor"],
    "ikonomika": ["евро", "инфлац", "бюджет", "данъ", "банк", "икономи", "economy", "inflation",
                  "market", "tariff", "budget", "energy"],
    "es": ["брюксел", "европейска комисия", "евросъюз", "ес ", "european union", "eu ", "brussels"],
    "tehnologii": ["изкуствен интелект", "ai ", "технолог", "кибер", "software", "tech", "cyber", "openai"],
    "nauka-zdrave": ["здрав", "болни", "учени", "health", "scien", "vaccine", "nasa"],
    "klimat": ["климат", "наводн", "пожар", "climate", "flood", "wildfire", "emission"],
    "dezinformacia": ["дезинформ", "пропаганд", "фалшив", "disinformation", "propaganda", "fact check"],
}


def fallback_categories(text: str):
    t = text.lower()
    cats = [c for c, words in KEYWORDS.items() if any(w in t for w in words)]
    return cats[:3] or ["drugi"]


def process_pending():
    if not GEMINI_KEY:
        log("Няма GEMINI_API_KEY - пропускам AI обработката")
        return
    rows = sb("GET", "articles", params={
        "select": "id,lang,title,summary,source", "ai_done": "eq.false",
        "order": "published_at.desc", "limit": str(AI_MAX_PER_RUN)})
    log(f"За AI обработка: {len(rows)}")
    cats_txt = "\n".join(f'  "{c["id"]}" = {c["name"]} ({c["hint"]})' for c in CATEGORIES)
    done = 0
    for i in range(0, len(rows), AI_BATCH):
        batch = rows[i:i + AI_BATCH]
        items = [{"i": k, "lang": r["lang"], "source": r["source"], "title": r["title"],
                  "summary": (r["summary"] or "")[:500]} for k, r in enumerate(batch)]
        prompt = PROMPT.format(cats=cats_txt, items=json.dumps(items, ensure_ascii=False))
        try:
            raw = gemini(prompt)
            raw = raw.strip().removeprefix("```json").removesuffix("```").strip()
            results = {int(x["i"]): x for x in json.loads(raw) if isinstance(x, dict) and "i" in x}
        except Exception as e:
            log(f"  ! AI грешка: {e}")
            if "Няма наличен" in str(e):
                break
            results = {}
        for k, r in enumerate(batch):
            x = results.get(k)
            if x:
                cats = [c for c in (x.get("categories") or []) if c in CAT_IDS][:3]
                patch = {
                    "categories": cats or fallback_categories(r["title"] + " " + (r["summary"] or "")),
                    "people": [p.strip() for p in (x.get("people") or []) if isinstance(p, str) and p.strip()][:6],
                    "tags": [t.strip() for t in (x.get("tags") or []) if isinstance(t, str) and t.strip()][:4],
                    "ai_done": True,
                }
                if r["lang"] != "bg":
                    patch["title_bg"] = x.get("title_bg")
                    patch["summary_bg"] = x.get("summary_bg")
            else:
                # временно - по ключови думи; ще се опита пак при следващото пускане
                patch = {"categories": fallback_categories(r["title"] + " " + (r["summary"] or ""))}
            sb("PATCH", "articles", params={"id": f"eq.{r['id']}"}, json=patch)
            done += 1 if x else 0
        log(f"  обработени {min(i + AI_BATCH, len(rows))}/{len(rows)}")
        time.sleep(AI_PAUSE)
    log(f"AI обработени: {done}")


if __name__ == "__main__":
    if not SUPABASE_URL or not SUPABASE_KEY:
        sys.exit("Липсват SUPABASE_URL / SUPABASE_SERVICE_KEY")
    collect()
    process_pending()
