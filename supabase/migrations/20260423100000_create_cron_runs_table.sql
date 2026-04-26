create table cron_runs (
  id          uuid primary key default gen_random_uuid(),
  source      text        not null,
  ran_at      timestamptz not null default now(),
  checked     int         not null default 0,
  flagged     int         not null default 0,
  crit_count  int         not null default 0,
  alerted     boolean     not null default false,
  details     jsonb
);

create index cron_runs_source_ran_at on cron_runs (source, ran_at desc);
