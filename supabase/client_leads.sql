-- Lead Safety Net: shared "client_leads" table. APPLIED 26 Nov 2026 to the airocket Supabase project. Undo: drop table public.client_leads;
-- One table for all client sites; rows are labeled by "site". Only the server (service key) can read or write.
create table if not exists public.client_leads (
  id            uuid primary key default gen_random_uuid(),
  ref_code      text not null unique,            -- what the visitor sees, e.g. L-4PAUYC
  site          text not null,                   -- client site label, e.g. mj-moving
  env           text not null default 'production', -- production or preview (preview rows are tests)
  kind          text not null,                   -- quote, claim, partner
  status        text not null default 'received',-- received, emailed, needs_attention, held, contacted
  name          text,
  phone         text,
  email         text,
  answers       jsonb not null default '{}'::jsonb,
  consent       jsonb not null default '{}'::jsonb,
  source_page   text,
  email_id      text,                            -- Resend id, for delivery status later
  email_attempts int not null default 0,
  last_error    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists client_leads_site_created on public.client_leads (site, created_at desc);
create index if not exists client_leads_open on public.client_leads (status) where status in ('received','needs_attention');

-- Lock it down: no public access of any kind. The server's service key bypasses this.
alter table public.client_leads enable row level security;
revoke all on public.client_leads from anon, authenticated;
grant select, insert, update on public.client_leads to service_role;
