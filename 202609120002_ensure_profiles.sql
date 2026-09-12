create or replace function public.ensure_current_profile()
returns public.profiles
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  auth_user_record auth.users;
  desired text;
  result public.profiles;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  select *
  into auth_user_record
  from auth.users
  where id = auth.uid();

  if auth_user_record.id is null then
    raise exception 'Authenticated user not found';
  end if;

  select *
  into result
  from public.profiles
  where id = auth_user_record.id;

  if result.id is not null then
    return result;
  end if;

  desired := regexp_replace(
    coalesce(auth_user_record.raw_user_meta_data->>'username', split_part(auth_user_record.email, '@', 1)),
    '[^A-Za-z0-9_]',
    '',
    'g'
  );
  desired := substr(coalesce(nullif(desired, ''), 'player'), 1, 18);
  if char_length(desired) < 3 then desired := 'player'; end if;

  while exists (select 1 from public.profiles where username = desired) loop
    desired := substr(desired, 1, 18) || substr(encode(gen_random_bytes(3), 'hex'), 1, 5);
  end loop;

  insert into public.profiles (id, username, friend_code)
  values (auth_user_record.id, desired, public.generate_friend_code())
  on conflict (id) do nothing
  returning * into result;

  if result.id is null then
    select * into result from public.profiles where id = auth_user_record.id;
  end if;

  return result;
end;
$$;

revoke execute on function public.ensure_current_profile() from public, anon;
grant execute on function public.ensure_current_profile() to authenticated;
