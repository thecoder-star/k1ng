create extension if not exists pgcrypto;

create type public.friend_request_status as enum ('pending', 'accepted', 'declined', 'blocked');
create type public.conversation_kind as enum ('direct', 'group');
create type public.attachment_kind as enum ('image', 'video', 'voice', 'file');
create type public.call_status as enum ('ringing', 'active', 'ended', 'declined', 'missed');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null unique check (username ~ '^[A-Za-z0-9_]{3,24}$'),
  avatar_url text,
  bio text not null default '' check (char_length(bio) <= 160),
  friend_code text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.admin_roles (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  granted_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);

create table public.friend_requests (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references public.profiles(id) on delete cascade,
  receiver_id uuid not null references public.profiles(id) on delete cascade,
  status public.friend_request_status not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (sender_id <> receiver_id)
);
create unique index friend_requests_pair_pending
  on public.friend_requests (least(sender_id, receiver_id), greatest(sender_id, receiver_id))
  where status in ('pending', 'accepted');

create table public.friendships (
  user_low uuid not null references public.profiles(id) on delete cascade,
  user_high uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_low, user_high),
  check (user_low < user_high)
);

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  kind public.conversation_kind not null,
  name text check (name is null or char_length(name) between 1 and 60),
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.conversation_members (
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  joined_at timestamptz not null default now(),
  last_read_at timestamptz not null default now(),
  muted boolean not null default false,
  primary key (conversation_id, user_id)
);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  sender_id uuid not null references public.profiles(id),
  body text check (body is null or char_length(body) <= 4000),
  reply_to uuid references public.messages(id) on delete set null,
  edited_at timestamptz,
  deleted_at timestamptz,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index messages_conversation_created on public.messages(conversation_id, created_at desc);

create table public.message_receipts (
  message_id uuid not null references public.messages(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  delivered_at timestamptz not null default now(),
  read_at timestamptz,
  primary key (message_id, user_id)
);

create table public.message_attachments (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.messages(id) on delete cascade,
  uploader_id uuid not null references public.profiles(id),
  storage_path text not null unique,
  kind public.attachment_kind not null,
  mime_type text not null,
  size_bytes bigint not null check (size_bytes > 0 and size_bytes <= 26214400),
  created_at timestamptz not null default now()
);

create table public.call_sessions (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  started_by uuid not null references public.profiles(id),
  has_video boolean not null default false,
  status public.call_status not null default 'ringing',
  started_at timestamptz not null default now(),
  answered_at timestamptz,
  ended_at timestamptz
);

create table public.games (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 100),
  author text not null default '',
  html_url text not null check (html_url ~ '^https://'),
  cover_url text not null check (cover_url ~ '^https://'),
  featured boolean not null default false,
  published boolean not null default true,
  sort_order integer not null default 0,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.app_settings (
  id smallint primary key default 1 check (id = 1),
  notification_text text not null default '' check (char_length(notification_text) <= 500),
  notification_enabled boolean not null default false,
  notification_delay_seconds integer not null default 0 check (notification_delay_seconds between 0 and 86400),
  notification_duration_seconds integer not null default 0 check (notification_duration_seconds between 0 and 86400),
  lock_enabled boolean not null default false,
  lock_password_hash text,
  lock_version text not null default gen_random_uuid()::text,
  updated_by uuid references public.profiles(id),
  updated_at timestamptz not null default now()
);
insert into public.app_settings (id) values (1) on conflict do nothing;

create table public.admin_audit_log (
  id bigint generated always as identity primary key,
  admin_id uuid not null references public.profiles(id),
  action text not null,
  target_type text,
  target_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table public.access_gate_attempts (
  client_hash text primary key,
  attempt_count integer not null default 0,
  window_started_at timestamptz not null default now()
);

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger profiles_updated_at before update on public.profiles
for each row execute function public.set_updated_at();
create trigger friend_requests_updated_at before update on public.friend_requests
for each row execute function public.set_updated_at();
create trigger conversations_updated_at before update on public.conversations
for each row execute function public.set_updated_at();
create trigger games_updated_at before update on public.games
for each row execute function public.set_updated_at();

create or replace function public.generate_friend_code()
returns text language plpgsql as $$
declare
  generated text;
begin
  loop
    generated := upper(substr(encode(gen_random_bytes(8), 'hex'), 1, 8));
    exit when not exists (select 1 from public.profiles where friend_code = generated);
  end loop;
  return generated;
end;
$$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  desired text;
begin
  desired := regexp_replace(coalesce(new.raw_user_meta_data->>'username', split_part(new.email, '@', 1)), '[^A-Za-z0-9_]', '', 'g');
  desired := substr(coalesce(nullif(desired, ''), 'player'), 1, 18);
  if char_length(desired) < 3 then desired := 'player'; end if;
  while exists (select 1 from public.profiles where username = desired) loop
    desired := substr(desired, 1, 18) || substr(encode(gen_random_bytes(3), 'hex'), 1, 5);
  end loop;
  insert into public.profiles (id, username, friend_code)
  values (new.id, desired, public.generate_friend_code());
  return new;
end;
$$;

create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer set search_path = public
as $$ select exists(select 1 from public.admin_roles where user_id = auth.uid()); $$;

create or replace function public.is_conversation_member(target uuid)
returns boolean
language sql
stable
security definer set search_path = public
as $$ select exists(select 1 from public.conversation_members where conversation_id = target and user_id = auth.uid()); $$;

create or replace function public.are_friends(first_user uuid, second_user uuid)
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select exists(
    select 1 from public.friendships
    where user_low = least(first_user, second_user)
      and user_high = greatest(first_user, second_user)
  );
$$;

create or replace function public.can_view_profile(target_user uuid)
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select
    target_user = auth.uid()
    or public.are_friends(auth.uid(), target_user)
    or exists (
      select 1 from public.friend_requests request
      where request.status = 'pending'
        and (
          (request.sender_id = auth.uid() and request.receiver_id = target_user)
          or (request.receiver_id = auth.uid() and request.sender_id = target_user)
        )
    )
    or exists (
      select 1
      from public.conversation_members mine
      join public.conversation_members theirs
        on theirs.conversation_id = mine.conversation_id
      where mine.user_id = auth.uid()
        and theirs.user_id = target_user
    );
$$;

create or replace function public.send_friend_request(target_code text)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare target_id uuid; request_id uuid;
begin
  select id into target_id from public.profiles where friend_code = upper(trim(target_code));
  if target_id is null then raise exception 'Friend code not found'; end if;
  if target_id = auth.uid() then raise exception 'You cannot add yourself'; end if;
  if public.are_friends(auth.uid(), target_id) then raise exception 'You are already friends'; end if;
  insert into public.friend_requests(sender_id, receiver_id)
  values (auth.uid(), target_id) returning id into request_id;
  return request_id;
end;
$$;

create or replace function public.respond_friend_request(request_uuid uuid, accept_request boolean)
returns void
language plpgsql
security definer set search_path = public
as $$
declare request_row public.friend_requests;
begin
  select * into request_row from public.friend_requests
  where id = request_uuid and receiver_id = auth.uid() and status = 'pending'
  for update;
  if not found then raise exception 'Request not found'; end if;
  update public.friend_requests set status = case when accept_request then 'accepted'::public.friend_request_status else 'declined'::public.friend_request_status end where id = request_uuid;
  if accept_request then
    insert into public.friendships(user_low, user_high)
    values (least(request_row.sender_id, request_row.receiver_id), greatest(request_row.sender_id, request_row.receiver_id))
    on conflict do nothing;
  end if;
end;
$$;

create or replace function public.create_direct_conversation(other_user uuid)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare conversation_uuid uuid;
begin
  if not public.are_friends(auth.uid(), other_user) then raise exception 'You can only message friends'; end if;
  select c.id into conversation_uuid
  from public.conversations c
  where c.kind = 'direct'
    and (select count(*) from public.conversation_members cm where cm.conversation_id = c.id) = 2
    and exists(select 1 from public.conversation_members cm where cm.conversation_id = c.id and cm.user_id = auth.uid())
    and exists(select 1 from public.conversation_members cm where cm.conversation_id = c.id and cm.user_id = other_user)
  limit 1;
  if conversation_uuid is null then
    insert into public.conversations(kind, created_by) values ('direct', auth.uid()) returning id into conversation_uuid;
    insert into public.conversation_members(conversation_id, user_id) values (conversation_uuid, auth.uid()), (conversation_uuid, other_user);
  end if;
  return conversation_uuid;
end;
$$;

create or replace function public.create_group_conversation(conversation_name text, member_ids uuid[])
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare conversation_uuid uuid; member uuid;
begin
  if cardinality(member_ids) < 1 or cardinality(member_ids) > 49 then raise exception 'Choose between 1 and 49 members'; end if;
  foreach member in array member_ids loop
    if not public.are_friends(auth.uid(), member) then raise exception 'Every member must be your friend'; end if;
  end loop;
  insert into public.conversations(kind, name, created_by)
  values ('group', coalesce(nullif(trim(conversation_name), ''), 'Group chat'), auth.uid())
  returning id into conversation_uuid;
  insert into public.conversation_members(conversation_id, user_id)
  select conversation_uuid, member from (
    select auth.uid() member union select unnest(member_ids)
  ) members;
  return conversation_uuid;
end;
$$;

create or replace function public.mark_conversation_read(target_conversation uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  if not public.is_conversation_member(target_conversation) then raise exception 'Access denied'; end if;
  update public.conversation_members set last_read_at = now()
  where conversation_id = target_conversation and user_id = auth.uid();
  insert into public.message_receipts(message_id, user_id, read_at)
  select id, auth.uid(), now() from public.messages
  where conversation_id = target_conversation and sender_id <> auth.uid()
  on conflict (message_id, user_id) do update set read_at = excluded.read_at;
  update public.messages set read_at = coalesce(read_at, now())
  where conversation_id = target_conversation and sender_id <> auth.uid();
end;
$$;

alter table public.profiles enable row level security;
alter table public.admin_roles enable row level security;
alter table public.friend_requests enable row level security;
alter table public.friendships enable row level security;
alter table public.conversations enable row level security;
alter table public.conversation_members enable row level security;
alter table public.messages enable row level security;
alter table public.message_receipts enable row level security;
alter table public.message_attachments enable row level security;
alter table public.call_sessions enable row level security;
alter table public.games enable row level security;
alter table public.app_settings enable row level security;
alter table public.admin_audit_log enable row level security;
alter table public.access_gate_attempts enable row level security;

create policy "profiles visible to connected users" on public.profiles for select to authenticated using (public.can_view_profile(id));
create policy "users update own profile" on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());
create policy "admins view roles" on public.admin_roles for select to authenticated using (public.is_admin());
create policy "participants view requests" on public.friend_requests for select to authenticated using (sender_id = auth.uid() or receiver_id = auth.uid());
create policy "users view own friendships" on public.friendships for select to authenticated using (user_low = auth.uid() or user_high = auth.uid());
create policy "members view conversations" on public.conversations for select to authenticated using (public.is_conversation_member(id));
create policy "members view memberships" on public.conversation_members for select to authenticated using (public.is_conversation_member(conversation_id));
create policy "members view messages" on public.messages for select to authenticated using (public.is_conversation_member(conversation_id));
create policy "members send messages" on public.messages for insert to authenticated with check (sender_id = auth.uid() and public.is_conversation_member(conversation_id));
create policy "senders edit own messages" on public.messages for update to authenticated using (sender_id = auth.uid()) with check (sender_id = auth.uid());
create policy "members view receipts" on public.message_receipts for select to authenticated using (
  exists(select 1 from public.messages m where m.id = message_id and public.is_conversation_member(m.conversation_id))
);
create policy "members add own receipts" on public.message_receipts for insert to authenticated with check (
  user_id = auth.uid() and exists(select 1 from public.messages m where m.id = message_id and public.is_conversation_member(m.conversation_id))
);
create policy "members view attachments" on public.message_attachments for select to authenticated using (
  exists(select 1 from public.messages m where m.id = message_id and public.is_conversation_member(m.conversation_id))
);
create policy "members attach to own message" on public.message_attachments for insert to authenticated with check (
  uploader_id = auth.uid() and exists(select 1 from public.messages m where m.id = message_id and m.sender_id = auth.uid() and public.is_conversation_member(m.conversation_id))
);
create policy "members view calls" on public.call_sessions for select to authenticated using (public.is_conversation_member(conversation_id));
create policy "members create calls" on public.call_sessions for insert to authenticated with check (started_by = auth.uid() and public.is_conversation_member(conversation_id));
create policy "published games are visible" on public.games for select using (published or public.is_admin());
create policy "admins view settings" on public.app_settings for select to authenticated using (public.is_admin());
create policy "admins view audit log" on public.admin_audit_log for select to authenticated using (public.is_admin());

create or replace function public.get_public_app_settings()
returns table (
  notification_text text,
  notification_enabled boolean,
  notification_delay_seconds integer,
  notification_duration_seconds integer,
  lock_enabled boolean,
  lock_version text
)
language sql
stable
security definer set search_path = public
as $$
  select
    notification_text,
    notification_enabled,
    notification_delay_seconds,
    notification_duration_seconds,
    lock_enabled,
    lock_version
  from public.app_settings
  where id = 1;
$$;

revoke all on public.app_settings from anon, authenticated;
grant execute on function public.get_public_app_settings() to anon, authenticated;

create or replace view public.friend_requests_view
with (security_invoker = true)
as
select fr.id request_id, p.id, p.username, p.avatar_url, p.bio, fr.created_at
from public.friend_requests fr
join public.profiles p on p.id = fr.sender_id
where fr.receiver_id = auth.uid() and fr.status = 'pending';

create or replace view public.friends_view
with (security_invoker = true)
as
select p.id, p.username, p.avatar_url, p.bio, f.created_at
from public.friendships f
join public.profiles p on p.id = case when f.user_low = auth.uid() then f.user_high else f.user_low end
where f.user_low = auth.uid() or f.user_high = auth.uid();

create or replace view public.conversation_summaries
with (security_invoker = true)
as
select
  c.id conversation_id,
  case
    when c.kind = 'group' then c.name
    else coalesce(other_profile.username, 'Direct message')
  end title,
  case when c.kind = 'direct' then other_profile.avatar_url end avatar_url,
  latest.body last_message,
  coalesce(latest.created_at, c.created_at) last_message_at,
  c.kind,
  (
    select count(*)::integer
    from public.messages unread
    where unread.conversation_id = c.id
      and unread.sender_id <> auth.uid()
      and unread.created_at > mine.last_read_at
  ) unread_count
from public.conversations c
join public.conversation_members mine on mine.conversation_id = c.id and mine.user_id = auth.uid()
left join lateral (
  select p.username, p.avatar_url
  from public.conversation_members cm
  join public.profiles p on p.id = cm.user_id
  where cm.conversation_id = c.id and cm.user_id <> auth.uid()
  order by cm.joined_at
  limit 1
) other_profile on true
left join lateral (
  select m.body, m.created_at
  from public.messages m
  where m.conversation_id = c.id
  order by m.created_at desc
  limit 1
) latest on true;

grant select on public.friend_requests_view, public.friends_view, public.conversation_summaries to authenticated;
grant execute on function public.is_admin(), public.send_friend_request(text),
  public.respond_friend_request(uuid, boolean), public.create_direct_conversation(uuid),
  public.create_group_conversation(text, uuid[]), public.mark_conversation_read(uuid) to authenticated;
revoke execute on function public.send_friend_request(text),
  public.respond_friend_request(uuid, boolean), public.create_direct_conversation(uuid),
  public.create_group_conversation(text, uuid[]), public.mark_conversation_read(uuid) from public, anon;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('avatars', 'avatars', true, 5242880, array['image/jpeg','image/png','image/webp']),
  ('chat-media', 'chat-media', false, 26214400, array['image/jpeg','image/png','image/webp','image/gif','video/mp4','video/webm','audio/webm','audio/ogg','audio/mp4']),
  ('game-packages', 'game-packages', true, 104857600, array['text/html','application/zip'])
on conflict (id) do nothing;

create policy "avatar upload to own folder" on storage.objects for insert to authenticated
with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "avatar owners update files" on storage.objects for update to authenticated
using (bucket_id = 'avatars' and owner_id = auth.uid()::text);
create policy "avatar owners delete files" on storage.objects for delete to authenticated
using (bucket_id = 'avatars' and owner_id = auth.uid()::text);
create policy "members read chat media" on storage.objects for select to authenticated
using (
  bucket_id = 'chat-media'
  and public.is_conversation_member(((storage.foldername(name))[1])::uuid)
);
create policy "members upload chat media" on storage.objects for insert to authenticated
with check (
  bucket_id = 'chat-media'
  and public.is_conversation_member(((storage.foldername(name))[1])::uuid)
  and (storage.foldername(name))[2] = auth.uid()::text
);
create policy "admins upload game packages" on storage.objects for insert to authenticated
with check (
  bucket_id = 'game-packages'
  and public.is_admin()
  and (storage.foldername(name))[1] = auth.uid()::text
);
create policy "admins delete game packages" on storage.objects for delete to authenticated
using (bucket_id = 'game-packages' and public.is_admin());

create policy "members receive conversation broadcasts"
on realtime.messages for select to authenticated
using (
  realtime.messages.extension = 'broadcast'
  and split_part(realtime.topic(), ':', 1) = 'conversation'
  and public.is_conversation_member(split_part(realtime.topic(), ':', 2)::uuid)
);

create policy "members send conversation broadcasts"
on realtime.messages for insert to authenticated
with check (
  realtime.messages.extension = 'broadcast'
  and split_part(realtime.topic(), ':', 1) = 'conversation'
  and public.is_conversation_member(split_part(realtime.topic(), ':', 2)::uuid)
);

alter publication supabase_realtime add table public.messages;
alter publication supabase_realtime add table public.message_receipts;
alter publication supabase_realtime add table public.call_sessions;
