import type { SupabaseClient } from '@supabase/supabase-js'

jest.mock('@/lib/payment', () => ({
  paymentProvider: {
    createPendingInvoiceItem: jest.fn(),
    findInvoiceItem: jest.fn(),
    listInvoiceItems: jest.fn(),
  },
}))

import { paymentProvider } from '@/lib/payment'
import {
  isClosedSupportPlusBillingPeriod,
  prepareSupportPlusBilling,
} from '@/lib/payment/support-plus'

const createPendingInvoiceItem = paymentProvider.createPendingInvoiceItem as jest.MockedFunction<
  typeof paymentProvider.createPendingInvoiceItem
>
const findInvoiceItem = paymentProvider.findInvoiceItem as jest.MockedFunction<
  typeof paymentProvider.findInvoiceItem
>

describe('Support+ monthly billing', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    findInvoiceItem.mockResolvedValue(null)
  })

  test('only closed UTC billing periods can be frozen', () => {
    expect(
      isClosedSupportPlusBillingPeriod('2026-08', new Date('2026-09-01T00:00:00.000Z'))
    ).toBe(true)
    expect(
      isClosedSupportPlusBillingPeriod('2026-08', new Date('2026-08-31T23:59:59.999Z'))
    ).toBe(false)
    expect(isClosedSupportPlusBillingPeriod('2026-13', new Date('2027-01-01T00:00:00.000Z'))).toBe(false)
  })

  test('uses the immutable billing batch id for recovery and Stripe idempotency', async () => {
    const rpc = jest
      .fn()
      .mockResolvedValueOnce({
        data: [
          {
            batch_id: '11111111-1111-1111-1111-111111111111',
            user_id: '22222222-2222-2222-2222-222222222222',
            gross_tips_yen: 1500,
            currency: 'JPY',
          },
        ],
        error: null,
      })
      .mockResolvedValueOnce({ data: null, error: null })

    const inQuery = jest.fn().mockResolvedValue({
      data: [
        {
          id: '22222222-2222-2222-2222-222222222222',
          stripe_customer_id: 'cus_support_plus',
        },
      ],
      error: null,
    })
    const select = jest.fn().mockReturnValue({ in: inQuery })
    const from = jest.fn().mockReturnValue({ select })

    createPendingInvoiceItem.mockResolvedValue({ invoiceItemId: 'ii_support_plus' })

    const result = await prepareSupportPlusBilling(
      { rpc, from } as unknown as SupabaseClient,
      '2020-01'
    )

    expect(findInvoiceItem).toHaveBeenCalledTimes(1)
    expect(findInvoiceItem).toHaveBeenCalledWith({
      customerId: 'cus_support_plus',
      metadataKey: 'support_plus_batch_id',
      metadataValue: '11111111-1111-1111-1111-111111111111',
    })
    expect(createPendingInvoiceItem).toHaveBeenCalledTimes(1)
    expect(createPendingInvoiceItem).toHaveBeenCalledWith(
      expect.objectContaining({
        amountYen: 1500,
        customerId: 'cus_support_plus',
        idempotencyKey: 'support-plus:11111111-1111-1111-1111-111111111111',
        metadata: expect.objectContaining({
          type: 'support_plus_batch',
          support_plus_batch_id: '11111111-1111-1111-1111-111111111111',
        }),
      })
    )
    expect(rpc).toHaveBeenNthCalledWith(2, 'mark_support_plus_batch_invoice_item', {
      p_batch_id: '11111111-1111-1111-1111-111111111111',
      p_stripe_invoice_item_id: 'ii_support_plus',
    })
    expect(result).toEqual({
      prepared: 1,
      invoiceItemsCreated: 1,
      invoiceItemsRecovered: 0,
    })
  })

  test('recovers an existing pending or attached invoice item instead of creating a duplicate', async () => {
    const rpc = jest
      .fn()
      .mockResolvedValueOnce({
        data: [
          {
            batch_id: '11111111-1111-1111-1111-111111111111',
            user_id: '22222222-2222-2222-2222-222222222222',
            gross_tips_yen: 1500,
            currency: 'JPY',
          },
        ],
        error: null,
      })
      .mockResolvedValueOnce({ data: null, error: null })

    const inQuery = jest.fn().mockResolvedValue({
      data: [
        {
          id: '22222222-2222-2222-2222-222222222222',
          stripe_customer_id: 'cus_support_plus',
        },
      ],
      error: null,
    })
    const select = jest.fn().mockReturnValue({ in: inQuery })
    const from = jest.fn().mockReturnValue({ select })

    findInvoiceItem.mockResolvedValue({ invoiceItemId: 'ii_recovered' })

    const result = await prepareSupportPlusBilling(
      { rpc, from } as unknown as SupabaseClient,
      '2020-01'
    )

    expect(createPendingInvoiceItem).not.toHaveBeenCalled()
    expect(rpc).toHaveBeenNthCalledWith(2, 'mark_support_plus_batch_invoice_item', {
      p_batch_id: '11111111-1111-1111-1111-111111111111',
      p_stripe_invoice_item_id: 'ii_recovered',
    })
    expect(result).toEqual({
      prepared: 1,
      invoiceItemsCreated: 0,
      invoiceItemsRecovered: 1,
    })
  })

  test('does not call Stripe when there are no pending Support+ batches', async () => {
    const rpc = jest.fn().mockResolvedValue({ data: [], error: null })

    const result = await prepareSupportPlusBilling(
      { rpc } as unknown as SupabaseClient,
      '2020-01'
    )

    expect(findInvoiceItem).not.toHaveBeenCalled()
    expect(createPendingInvoiceItem).not.toHaveBeenCalled()
    expect(result).toEqual({
      prepared: 0,
      invoiceItemsCreated: 0,
      invoiceItemsRecovered: 0,
    })
  })

  test('fails closed when a Support+ user has no Stripe customer', async () => {
    const rpc = jest.fn().mockResolvedValue({
      data: [
        {
          batch_id: '11111111-1111-1111-1111-111111111111',
          user_id: '22222222-2222-2222-2222-222222222222',
          gross_tips_yen: 500,
          currency: 'JPY',
        },
      ],
      error: null,
    })
    const inQuery = jest.fn().mockResolvedValue({
      data: [{ id: '22222222-2222-2222-2222-222222222222', stripe_customer_id: null }],
      error: null,
    })
    const select = jest.fn().mockReturnValue({ in: inQuery })
    const from = jest.fn().mockReturnValue({ select })

    await expect(
      prepareSupportPlusBilling({ rpc, from } as unknown as SupabaseClient, '2020-01')
    ).rejects.toThrow('has no Stripe customer')

    expect(findInvoiceItem).not.toHaveBeenCalled()
    expect(createPendingInvoiceItem).not.toHaveBeenCalled()
  })
})
