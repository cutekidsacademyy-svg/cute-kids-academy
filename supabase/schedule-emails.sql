-- Schedules the two background jobs (Prompt 8). Run ONCE in the Supabase SQL editor, after:
--   1. Database > Extensions: switch on "pg_cron" and "pg_net".
--   2. Vercel has the environment variable CRON_SECRET (any long random string you make up),
--      plus RESEND_API_KEY and RESEND_FROM, and the project has been redeployed.
-- Then replace the two placeholders below (<SITE_URL> and <CRON_SECRET>) and run it.
-- This file in Git keeps the placeholders: never commit the real secret.
--
--   <SITE_URL>     e.g. https://cutekidsacademy-eg.vercel.app   (no trailing slash)
--   <CRON_SECRET>  the same value as the Vercel variable CRON_SECRET

-- Every minute: send any emails waiting in the queue (only calls the site when something is waiting).
select cron.schedule('cka-send-emails', '* * * * *', $job$
  select net.http_post(
    url := '<SITE_URL>/api/portal-send-emails',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer <CRON_SECRET>'),
    body := '{}'::jsonb)
  where exists (select 1 from public.email_outbox where status = 'pending')
$job$);

-- Every 15 minutes: run the deadline clock (warnings and automatic escalation), then send.
select cron.schedule('cka-deadline-check', '*/15 * * * *', $job$
  select net.http_post(
    url := '<SITE_URL>/api/portal-send-emails',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer <CRON_SECRET>'),
    body := '{"check": true}'::jsonb)
$job$);

-- To look at the jobs:   select jobid, jobname, schedule, active from cron.job;
-- To see recent runs:    select * from cron.job_run_details order by start_time desc limit 10;
-- To stop them:          select cron.unschedule('cka-send-emails'); select cron.unschedule('cka-deadline-check');
