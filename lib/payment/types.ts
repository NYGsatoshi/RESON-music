export interface CustomerParams {
  metadata: Record<string, string>
}

export interface OneTimeChargeParams {
  amountYen: number
  customerId?: string
  metadata: Record<string, string>
}

export interface OneTimeChargeResult {
  providerChargeId: string
  clientSecret: string | null
}

export interface SubscriptionCheckoutParams {
  customerId: string
  priceId: string
  successUrl: string
  cancelUrl: string
  metadata: Record<string, string>
}

export interface BillingPortalParams {
  customerId: string
  returnUrl: string
}

export interface PendingInvoiceItemParams {
  customerId: string
  amountYen: number
  description: string
  metadata: Record<string, string>
  // Stable across retries. Required by Support+ monthly billing so a crash after the
  // Stripe call cannot create a second invoice item when the job is retried.
  idempotencyKey?: string
}

export interface PendingInvoiceItemLookupParams {
  customerId: string
  metadataKey: string
  metadataValue: string
}

export interface ProviderInvoiceItem {
  providerInvoiceItemId: string
  metadata: Record<string, string>
}

// 業者ごとに異なるWebhook形式を共通フォーマットへ変換した結果（第3章）
export type NormalizedWebhookEvent =
  | { kind: 'checkout_completed'; userId: string; plan: string }
  | { kind: 'subscription_updated'; userId: string; plan: string; active: boolean }
  | { kind: 'subscription_deleted'; userId: string }
  | { kind: 'charge_succeeded'; providerChargeId: string; metadata: Record<string, string> }
  | {
      kind: 'invoice_paid'
      providerEventId: string
      providerInvoiceId: string
    }
  | {
      kind: 'invoice_payment_failed'
      providerEventId: string
      providerInvoiceId: string
    }
  | { kind: 'ignored' }

export class WebhookVerificationError extends Error {}

export interface PaymentProvider {
  readonly name: string
  createCustomer(params: CustomerParams): Promise<{ customerId: string }>
  createOneTimeCharge(params: OneTimeChargeParams): Promise<OneTimeChargeResult>
  createSubscriptionCheckout(params: SubscriptionCheckoutParams): Promise<{ url: string | null }>
  createBillingPortalSession(params: BillingPortalParams): Promise<{ url: string | null }>
  // 保留中の請求項目を作成する（顧客の次回請求書に自動的に合算される。サブスク顧客専用）
  createPendingInvoiceItem(params: PendingInvoiceItemParams): Promise<{ invoiceItemId: string }>
  // DBへprovider IDを保存する前にプロセスが落ちた場合のrecovery用。
  findPendingInvoiceItem(params: PendingInvoiceItemLookupParams): Promise<{ invoiceItemId: string } | null>
  // Webhook の invoice.lines は全件を含むとは限らないため、provider API から
  // 対象 invoice に紐づく invoice item を全ページ取得する。
  listInvoiceItems(providerInvoiceId: string): Promise<ProviderInvoiceItem[]>
  // 署名検証 + 共通フォーマットへの正規化（業者依存のWebhook検証ロジックをこの層に閉じ込める）
  verifyAndNormalizeWebhook(rawBody: string, signature: string | null): NormalizedWebhookEvent
}
