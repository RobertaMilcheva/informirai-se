-- ИнформирAI се — база данни
-- Пусни целия файл веднъж в Supabase → SQL Editor → New query → Run.

-- помощна функция (нужна за индекса за търсене)
create or replace function public.arr_text(arr text[])
returns text language sql immutable parallel safe as $$
  select coalesce(array_to_string(arr, ' '), '')
$$;

create table if not exists public.articles (
  id            bigint generated always as identity primary key,
  url           text not null unique,
  source        text not null,
  source_name   text not null,
  lang          text not null,               -- 'bg' или 'en'
  title         text not null,
  summary       text,
  title_bg      text,                         -- превод (само за чужди статии)
  summary_bg    text,
  image_url     text,
  published_at  timestamptz not null default now(),
  fetched_at    timestamptz not null default now(),
  categories    text[] not null default '{}',
  people        text[] not null default '{}', -- имена на хора, на български
  tags          text[] not null default '{}', -- теми/събития, на български
  ai_done       boolean not null default false,
  fts tsvector generated always as (
    to_tsvector('simple',
      coalesce(title,'') || ' ' || coalesce(summary,'') || ' ' ||
      coalesce(title_bg,'') || ' ' || coalesce(summary_bg,'') || ' ' ||
      public.arr_text(people) || ' ' || public.arr_text(tags))
  ) stored
);

create index if not exists articles_published_idx on public.articles (published_at desc);
create index if not exists articles_categories_idx on public.articles using gin (categories);
create index if not exists articles_people_idx on public.articles using gin (people);
create index if not exists articles_tags_idx on public.articles using gin (tags);
create index if not exists articles_fts_idx on public.articles using gin (fts);
create index if not exists articles_pending_idx on public.articles (ai_done) where ai_done = false;

-- Кеш за AI анализите, за да не се хаби безплатната квота
create table if not exists public.analyses (
  key         text primary key,
  content     jsonb not null,
  created_at  timestamptz not null default now()
);

-- Сигурност: приложението може само да ЧЕТЕ статии.
-- Писането става само от събирача (с тайния ключ).
alter table public.articles enable row level security;
alter table public.analyses enable row level security;

drop policy if exists "public read articles" on public.articles;
create policy "public read articles" on public.articles
  for select to anon, authenticated using (true);

-- Брой статии по човек (за страницата на човека и "свързани хора")
create or replace function public.top_people(min_count int default 2, max_rows int default 200)
returns table(name text, n bigint)
language sql stable as $$
  select p as name, count(*) as n
  from public.articles, unnest(people) as p
  group by p having count(*) >= min_count
  order by n desc limit max_rows;
$$;

create or replace function public.co_people(person text, max_rows int default 12)
returns table(name text, n bigint)
language sql stable as $$
  select p as name, count(*) as n
  from public.articles, unnest(people) as p
  where people @> array[person] and p <> person
  group by p order by n desc limit max_rows;
$$;

grant execute on function public.top_people(int,int) to anon, authenticated;
grant execute on function public.co_people(text,int) to anon, authenticated;
