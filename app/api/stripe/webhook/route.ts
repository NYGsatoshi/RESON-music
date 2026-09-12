import { paymentProvider, WebhookVerificationError } from '@/lib/payment'
import { createServiceClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'

const KNOWN_PLANS = new Set(['free', 'standard', 'student', 'support_plus'])

// Webhook は冪等に実装（同一イベントが複数回届く前提）。プロバイダ依存の検証/正規化はlib/payment層に集約
export async function POST(req: NextRequest) {
  const body = await req.text()
  const sig = req.headers.get('stripe-signature')

  let normalized
  try {
    normalized = paymentProvider.verifyAndNormalizeWebhook(body, sig)
  } catch (e) {
    if (e instanceof WebhookVerificationError) {
      return NextResponse.json({ error: e.message }, { status: 400 })
    }
    throw e
  }

  const supabase = await createServiceClient()

  switch (normalized.kind) {
    case 'checkout_completed':
      await handleCheckoutCompleted(supabase, normalized.userId, normalized.plan)
      break
    case 'subscription_updated':
      await handleSubscriptionUpdated(supabase, normalized.userId, normalized.plan, normalized.active)
      break
    case 'subscription_deleted':
      await handleSubscriptionDeleted(supabase, normalized.userId)
      break
    case 'charge_succeeded':
      if (normalized.metadata.type === 'boost') {
        await handleBoostSucceeded(supabase, normalized.providerChargeId, normalized.metadata)
      } else {
        await handleTipSucceeded(supabase, normalized.providerChargeId, normalized.metadata)
      }
      break
    case 'invoice_paid':
      await handleSupportPlusInvoicePaid(
        supabase,
        normalized.providerEventId,
        normalized.providerInvoiceId
      )
      break
    case 'invoice_payment_failed':
      await handleSupportPlusInvoicePaymentFailed(
        supabase,
        normalized.providerEventId,
        normalized.providerInvoiceId
      )
      break
    case 'ignored':
    default:
      // 未処理イベントは無視（200を返して再送させない）
      break
  }

  return NextResponse.json({ received: true })
}

async function handleCheckoutCompleted(
  supabase: Awaited<ReturnType<typeof createServiceClient>>,
  userId: string,
  plan: string
) {
  await supabase
    .from('users')
    .update({ plan })
    .eq('id', userId)
}

async function handleSubscriptionUpdated(
  supabase: Awaited<ReturnType<typeof createServiceClient>>,
  userId: string,
  plan: string,
  active: boolean
) {
  // active / trialing のみプランを維持。それ以外は free に戻す
  const newPlan = active ? plan : 'free'

  await supabase
    .from('users')
    .update({ plan: newPlan })
    .eq('id', userId)
}

async function handleSubscriptionDeleted(
  supabase: Awaited<ReturnType<typeof createServiceClient>>,
  userId: string
) {
  await supabase
    .from('users')
    .update({ plan: 'free' })
    .eq('id', userId)
}

type PersistedSupport = {
  id: string
  track_id: string
  amount_yen: number
  plan_at_support?: string | null
}

async function handleTipSucceeded(
  supabase: Awaited<ReturnType<typeof createServiceClient>>,
  providerChargeId: string,
  metadata: Record<string, string>
) {
  const { track_id, user_id, net_yen, track_plays_at_support } = metadata
  if (!track_id || !user_id || !net_yen) return

  const planAtSupport = metadata.plan && KNOWN_PLANS.has(metadata.plan) ? metadata.plan : null
  let persistedSupport: PersistedSupport | null = null

  const { data: insertedSupport, error: insertError } = await supabase
    .from('supports')
    .insert({
      track_id,
      user_id,
      amount_yen: Number(net_yen),
      payment_id: providerChargeId,
      track_plays_at_support: track_plays_at_support ? Number(track_plays_at_support) : null,
      plan_at_support: planAtSupport,
      funding_status: 'confirmed',
      confirmed_at: new Date().toISOString(),
    })
    .select('id, track_id, amount_yen, plan_at_support')
    .single()

  if (insertError?.code === '23505') {
    // The support row may have committed while the previous webhook attempt failed
    // before the artist ledger write. Recover the persisted source and retry the
    // idempotent ledger credit instead of returning early.
    const { data: existingSupport, error: existingError } = await supabase
      .from('supports')
      .select('id, track_id, amount_yen, plan_at_support')
      .eq('payment_id', providerChargeId)
      .single()
    if (existingError) throw existingError
    persistedSupport = existingSupport as PersistedSupport | null
  } else if (insertError) {
    throw insertError
  } else {
    persistedSupport = insertedSupport as PersistedSupport | null
  }

  if (!persistedSupport) return

  // Support+ deferred tips normally do not create PaymentIntents. Keep the snapshot
  // check here for compatibility with any already-created legacy payment intent.
  if (persistedSupport.plan_at_support === 'support_plus') return

  const { data: track } = await supabase
    .from('tracks')
    .select('artist_id')
    .eq('id', persistedSupport.track_id)
    .single()
  if (!track) return

  // New one-time tip credits also go through the append-only ledger so future balance
  // changes remain traceable and retry-safe. Replaying the webhook reuses support.id,
  // so credit_artist_once becomes a no-op after the first successful credit.
  const { error: creditError } = await supabase.rpc('credit_artist_once', {
    p_artist_id: track.artist_id,
    p_entry_type: 'tip_credit',
    p_source_type: 'support',
    p_source_id: persistedSupport.id,
    p_amount_yen: Number(persistedSupport.amount_yen),
    p_currency: 'JPY',
  })
  if (creditError) throw creditError
}

function supportPlusBatchIds(invoiceItemMetadata: Record<string, string>[]): string[] {
  return [
    ...new Set(
      invoiceItemMetadata
        .filter((metadata) => metadata.type === 'support_plus_batch')
        .map((metadata) => metadata.support_plus_batch_id)
        .filter((batchId): batchId is string => Boolean(batchId))
    ),
  ]
}

async function handleSupportPlusInvoicePaid(
  supabase: Awaited<ReturnType<typeof createServiceClient>>,
  providerEventId: string,
  providerInvoiceId: string
) {
  // invoice.lines embedded in a webhook can be truncated. Resolve all invoice items
  // from the provider before deciding which Support+ batches this payment confirms.
  const invoiceItemMetadata = await paymentProvider.listInvoiceItemMetadata(providerInvoiceId)

  for (const batchId of supportPlusBatchIds(invoiceItemMetadata)) {
    // One RPC transaction records payment evidence, marks all batch items confirmed,
    // creates the settlement, appends artist ledger credits, and updates balance cache.
    const { error } = await supabase.rpc('confirm_support_plus_billing', {
      p_batch_id: batchId,
      p_stripe_invoice_id: providerInvoiceId,
      p_provider_event_id: providerEventId,
    })
    if (error) throw error
  }
}

async function handleSupportPlusInvoicePaymentFailed(
  supabase: Awaited<ReturnType<typeof createServiceClient>>,
  providerEventId: string,
  providerInvoiceId: string
) {
  const invoiceItemMetadata = await paymentProvider.listInvoiceItemMetadata(providerInvoiceId)

  for (const batchId of supportPlusBatchIds(invoiceItemMetadata)) {
    const { error } = await supabase.rpc('mark_support_plus_billing_failed', {
      p_batch_id: batchId,
      p_stripe_invoice_id: providerInvoiceId,
      p_provider_event_id: providerEventId,
    })
    if (error) throw error
  }
}

const BOOST_ARTIST_SHARE = 0.7 // 21円（70%）。残り30%は運営取得（投げ銭より高め）

async function handleBoostSucceeded(
  supabase: Awaited<ReturnType<typeof createServiceClient>>,
  providerChargeId: string,
  metadata: Record<string, string>
) {
  const { track_id, user_id, year_month } = metadata
  if (!track_id || !user_id || !year_month) return

  // 冪等: payment_id で重複チェック
  const { data: existing } = await supabase
    .from('boost_hearts')
    .select('id')
    .eq('payment_id', providerChargeId)
    .single()
  if (existing) return

  const { error: insertError } = await supabase.from('boost_hearts').insert({
    track_id,
    user_id,
    year_month,
    amount_yen: 30,
    payment_id: providerChargeId,
    billed: true,
  })
  if (insertError?.code === '23505') return
  if (insertError) throw insertError

  const { data: track } = await supabase.from('tracks').select('artist_id').eq('id', track_id).single()
  if (!track) return

  // ブースト課金は月額プール按分を経由せず、アーティストへ直接送金（投げ銭と同方式）
  await supabase.rpc('add_artist_balance', {
    p_artist_id: track.artist_id,
    p_amount: 30 * BOOST_ARTIST_SHARE,
  })
}
