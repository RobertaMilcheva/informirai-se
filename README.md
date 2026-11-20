# ИнформирAI се

Лично приложение за новини: събира статии от избрани източници на всеки час, подрежда ги по теми, пази архив и с AI (безплатния Gemini) обяснява предисторията и кой кой е.

## Как работи
- `collector/` — събирачът. GitHub Actions го пуска на всеки час (`.github/workflows/collect.yml`).
- `supabase/schema.sql` — базата данни (архивът).
- `public/` — самото приложение (отваря се на телефона).
- `api/analyze.js` — AI анализът („Свържи картинката“, „Кой е…?“).
- `config/sources.json` — източниците. `config/categories.json` — категориите. И двата файла могат да се редактират.

## Настройки
**GitHub → Settings → Secrets and variables → Actions → New repository secret**
- `SUPABASE_URL` — Supabase → Project Settings → API (Project URL)
- `SUPABASE_SERVICE_KEY` — Supabase → Project Settings → API Keys → **secret** ключът
- `GEMINI_API_KEY` — от aistudio.google.com

**Vercel → Project → Settings → Environment Variables**
- `SUPABASE_URL` — същото като горе
- `SUPABASE_ANON_KEY` — Supabase → API Keys → **publishable** (или anon) ключът
- `SUPABASE_SERVICE_KEY` — secret ключът (за кеширане на AI анализите)
- `GEMINI_API_KEY` — същият Gemini ключ

## Бележки
- Свободна Европа е изключена: българската редакция спря да публикува на 31.03.2026.
- FT, The Economist, NYT, WSJ и Washington Post не са включени (платени са).
- Ако даден модел на Gemini спре да съществува, задай друг в GitHub → Settings → Variables → `GEMINI_MODEL`.
