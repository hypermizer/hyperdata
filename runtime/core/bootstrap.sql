-- Local identity compatibility for the existing owner policies and ledger RPCs.
-- There is no hosted authentication service or password login.
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists "uuid-ossp" with schema extensions;
create schema if not exists auth;
create table auth.users (
 id uuid primary key, instance_id uuid, aud text, role text, email text,
 encrypted_password text, email_confirmed_at timestamptz,
 raw_app_meta_data jsonb default '{}', raw_user_meta_data jsonb default '{}',
 created_at timestamptz default now(), updated_at timestamptz default now()
);
create function auth.jwt() returns jsonb language sql stable as
 $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
create function auth.uid() returns uuid language sql stable as
 $$ select coalesce(nullif(current_setting('request.jwt.claim.sub',true),''),auth.jwt()->>'sub')::uuid $$;
create function auth.role() returns text language sql stable as
 $$ select coalesce(nullif(current_setting('request.jwt.claim.role',true),''),auth.jwt()->>'role') $$;
grant usage on schema auth, extensions to authenticated, service_role;
grant execute on all functions in schema auth to authenticated, service_role;
