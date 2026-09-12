-- Do not automatically rebill/recredit Support+ tips from periods that were already
-- touched by the pre-ledger settlement function. The legacy table cannot prove Stripe
-- collection and does not contain artist_id, so those rows require reconciliation.

alter table supports
  drop constraint supports_funding_status_check;

alter table supports
  add constraint supports_funding_status_check
    check (funding_status in (
      'not_applicable',
      'pending',
      'confirmed',
      'failed',
      'refunded',
      'disputed',
      'legacy_unverified'
    ));

update supports s
set funding_status = 'legacy_unverified'
where s.plan_at_support = 'support_plus'
  and s.amount_yen > 0
  and s.payment_id is null
  and s.funding_status = 'pending'
  and exists (
    select 1
    from support_plus_tip_batches legacy
    where legacy.user_id = s.user_id
      and legacy.year_month = s.billing_period
  );

-- Server-only audit surface for deciding whether a legacy period was actually charged
-- and what balance correction (if any) is required. A repeated legacy batch count > 1
-- is also a strong signal that the old non-idempotent settlement may have been retried.
create or replace view support_plus_legacy_reconciliation
with (security_invoker = true)
as
with support_totals as (
  select
    s.user_id,
    s.billing_period as year_month,
    count(*)::bigint as support_count,
    sum(s.amount_yen)::bigint as deferred_tips_yen
  from supports s
  where s.plan_at_support = 'support_plus'
    and s.funding_status = 'legacy_unverified'
  group by s.user_id, s.billing_period
),
legacy_totals as (
  select
    b.user_id,
    b.year_month,
    count(*)::bigint as legacy_batch_rows,
    sum(b.total_tips_yen) as legacy_recorded_gross_yen,
    sum(b.net_yen) as legacy_recorded_net_yen
  from support_plus_tip_batches b
  group by b.user_id, b.year_month
)
select
  st.user_id,
  st.year_month,
  st.support_count,
  st.deferred_tips_yen,
  lt.legacy_batch_rows,
  lt.legacy_recorded_gross_yen,
  lt.legacy_recorded_net_yen
from support_totals st
join legacy_totals lt
  on lt.user_id = st.user_id
 and lt.year_month = st.year_month;

revoke all on support_plus_legacy_reconciliation from public, anon, authenticated;
grant select on support_plus_legacy_reconciliation to service_role;
