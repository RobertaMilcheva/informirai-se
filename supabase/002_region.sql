-- Добавя разделение България / Светът. Пусни веднъж в Supabase → SQL Editor.
alter table public.articles add column if not exists region text;
create index if not exists articles_region_idx on public.articles (region, published_at desc);
-- временно разпределение по езика на източника
update public.articles set region = case when lang = 'bg' then 'bg' else 'world' end where region is null;
-- българските източници пишат и за света: нека AI ги прегледа отново
update public.articles set ai_done = false where lang = 'bg';
