-- Unique usernames for Blaksyd profiles.
--
-- Each user picks a handle (3–20 chars, [a-z0-9_]) shown across the product —
-- chat, nexus, listener-facing surfaces. The handle is unique case-insensitively
-- so "Echo" and "echo" can't both exist. Existing users without a username get
-- one auto-generated from their email local-part + a short suffix, so the
-- column can ship as NOT NULL after back-fill.

alter table public.profiles
    add column if not exists username text;

-- Format check: 3–20 chars, lowercase ascii letters/digits/underscore.
-- We normalise to lower at the app layer; the constraint mirrors that.
do $$
begin
    if not exists (
        select 1 from pg_constraint
        where conname = 'profiles_username_format_chk'
          and conrelid = 'public.profiles'::regclass
    ) then
        alter table public.profiles
            add constraint profiles_username_format_chk
            check (username is null or username ~ '^[a-z0-9_]{3,20}$');
    end if;
end$$;

-- Back-fill: derive a slug from the email local-part for any existing profile
-- that lacks a username. Falls back to 'user_<short-id>' if the email is
-- missing or yields an empty slug.
update public.profiles p
set username = sub.candidate
from (
    select
        p.id,
        substr(
            coalesce(
                nullif(
                    regexp_replace(
                        lower(split_part(u.email, '@', 1)),
                        '[^a-z0-9_]', '', 'g'
                    ),
                    ''
                ),
                'user'
            ),
            1, 13
        ) || '_' || substr(replace(p.id::text, '-', ''), 1, 6) as candidate
    from public.profiles p
    join auth.users u on u.id = p.id
    where p.username is null
) sub
where p.id = sub.id and p.username is null;

-- After back-fill, lock it in: every profile must have one.
alter table public.profiles
    alter column username set not null;

-- Case-insensitive uniqueness — "Echo" and "echo" collide.
create unique index if not exists profiles_username_lower_uq
    on public.profiles ((lower(username)));
