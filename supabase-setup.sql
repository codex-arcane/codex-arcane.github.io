-- Run once in Supabase: SQL Editor > New query > paste > Run.
-- Usernames are stored as <username>@gear-users.app (same domain as emailDomain in config.js).
-- If you change the domain or the owner username, change it everywhere below too.

-- 1. Public storage bucket for category JSON files and images.
insert into storage.buckets (id, name, public)
values ('site', 'site', true)
on conflict (id) do nothing;

-- 2. One profile per account, so usernames are unique and can be checked before signing up.
create table if not exists public.profiles (
  username text primary key check (username ~ '^[a-z0-9_]{3,20}$'),
  user_id uuid unique not null references auth.users (id) on delete cascade
);
alter table public.profiles enable row level security;  -- no policies: only the functions below touch it

create or replace function public.username_available(name text)
returns boolean language sql security definer set search_path = public as $$
  select not exists (select 1 from public.profiles where username = lower(name));
$$;
grant execute on function public.username_available(text) to anon, authenticated;

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- Reject accounts that didn't come through the site's username form.
  if split_part(new.email, '@', 2) <> 'gear-users.app' then
    raise exception 'Invalid username account';
  end if;
  insert into public.profiles (username, user_id) values (split_part(new.email, '@', 1), new.id);
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- 3. Everyone can read site files; only the owner account can add, replace, or delete them.
drop policy if exists "site public read" on storage.objects;
create policy "site public read" on storage.objects
  for select using (bucket_id = 'site');

drop policy if exists "site owner insert" on storage.objects;
create policy "site owner insert" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'site' and (auth.jwt() ->> 'email') = 'codexarcane@gear-users.app');

drop policy if exists "site owner update" on storage.objects;
create policy "site owner update" on storage.objects
  for update to authenticated
  using (bucket_id = 'site' and (auth.jwt() ->> 'email') = 'codexarcane@gear-users.app')
  with check (bucket_id = 'site' and (auth.jwt() ->> 'email') = 'codexarcane@gear-users.app');

drop policy if exists "site owner delete" on storage.objects;
create policy "site owner delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'site' and (auth.jwt() ->> 'email') = 'codexarcane@gear-users.app');

-- 4. Each account's saved settings and favorites. Only the owner of a row can read or change it.
create table if not exists public.user_settings (
  user_id uuid primary key references auth.users (id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.user_settings enable row level security;

drop policy if exists "settings read own" on public.user_settings;
create policy "settings read own" on public.user_settings
  for select to authenticated using (auth.uid() = user_id);

drop policy if exists "settings insert own" on public.user_settings;
create policy "settings insert own" on public.user_settings
  for insert to authenticated with check (auth.uid() = user_id);

drop policy if exists "settings update own" on public.user_settings;
create policy "settings update own" on public.user_settings
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
