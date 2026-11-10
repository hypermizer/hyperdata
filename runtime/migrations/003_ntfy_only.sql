begin;
alter table alert_rules drop constraint if exists alert_rules_delivery_check;
update alert_rules set delivery='ntfy' where delivery<>'ntfy';
alter table alert_rules alter column delivery set default 'ntfy';
alter table alert_rules add constraint alert_rules_delivery_check check(delivery='ntfy');
-- Preserve sent history and retire pending email work without invoking a provider.
update notification_outbox set state='failed',lease_until=null,lease_token=null,
 last_error='Email disabled by owner; notifications are ntfy only',updated_at=clock_timestamp()
 where channel='email' and state in ('queued','retry_wait','claimed');
insert into runtime_migrations(version) values(3) on conflict do nothing;
commit;
