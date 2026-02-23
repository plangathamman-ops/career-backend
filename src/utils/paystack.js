/**
 * Paystack API - Initialize transaction (redirect user to pay)
 * Use live keys for production. Docs: https://paystack.com/docs/api/
 */

import crypto from 'crypto';

const PAYSTACK_BASE = 'https://api.paystack.co';

export async function initializeTransaction({ reference, amount, currency, callbackUrl, cancelUrl, customer }) {
  const secretKey = process.env.PAYSTACK_SECRET_KEY;
  if (!secretKey) throw new Error('PAYSTACK_SECRET_KEY is not set');

  // Paystack amounts are in smallest unit (cents for KES, kobo for NGN)
  const amountInSmallest = Math.round(Number(amount) * 100);

  const metadata = { customer_name: customer.name || 'Applicant' };
  if (cancelUrl) metadata.cancel_action = cancelUrl;

  const body = {
    reference,
    amount: amountInSmallest,
    currency: currency || 'KES',
    callback_url: callbackUrl,
    email: customer.email,
    metadata,
  };

  const res = await fetch(`${PAYSTACK_BASE}/transaction/initialize`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  if (!data.status || !data.data?.authorization_url) {
    const msg = data.message || 'Paystack payment init failed';
    console.error('[Paystack] Initialize failed:', {
      message: msg,
      status: data.status,
      httpStatus: res.status,
      meta: data.meta,
      errors: data.errors,
    });
    throw new Error(msg);
  }
  return { paymentLink: data.data.authorization_url, reference: data.data.reference };
}

/**
 * Charge via M-Pesa (Kenya) - user enters phone, we trigger STK push
 * Phone: accepts 07XXXXXXXX, 712345678, 254712345678, +254712345678
 * Returns { reference, status, display_text }
 */
export async function chargeMpesa({ reference, amount, currency, email, phone, metadata = {} }) {
  const secretKey = process.env.PAYSTACK_SECRET_KEY;
  if (!secretKey) throw new Error('PAYSTACK_SECRET_KEY is not set');

  let normalized = String(phone || '').replace(/\s/g, '').replace(/^\+/, '');
  if (normalized.startsWith('0')) normalized = '254' + normalized.slice(1);
  else if (!normalized.startsWith('254')) normalized = '254' + normalized;
  if (normalized.length < 12) throw new Error('Invalid phone number');
  // Paystack Kenya expects +254 format
  const phoneFormatted = '+' + normalized;

  const amountInSmallest = Math.round(Number(amount) * 100);

  const body = {
    email,
    amount: String(amountInSmallest),
    currency: currency || 'KES',
    reference,
    mobile_money: { phone: phoneFormatted, provider: 'mpesa' },
    metadata: { ...metadata, custom_fields: [] },
  };

  const res = await fetch(`${PAYSTACK_BASE}/charge`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  const d = data.data || {};

  // "Charge attempted" = success - request was sent; user completes on phone
  if (data.status && (d.status === 'pay_offline' || d.status === 'pending')) {
    return {
      reference: d.reference || reference,
      status: d.status,
      display_text: d.display_text || 'Please complete authorization on your mobile phone',
    };
  }

  // Charge failed - use a clear error message, not "Charge attempted"
  if (!data.status) {
    const raw = data.message || '';
    const msg = raw === 'Charge attempted'
      ? 'M-Pesa request could not be completed. Please try Card/Bank or check your phone number (use 2547XXXXXXXX).'
      : raw || 'M-Pesa charge failed';
    throw new Error(msg);
  }

  // Unexpected status (e.g. failed, send_otp) - surface gateway response if available
  if (d.status === 'failed') {
    const reason = d.gateway_response || d.message || 'Payment could not be processed';
    throw new Error(reason);
  }

  return {
    reference: d.reference || reference,
    status: d.status || 'pay_offline',
    display_text: d.display_text || 'Please complete authorization on your mobile phone',
  };
}

/**
 * Verify transaction with Paystack (GET /transaction/verify/:reference)
 * Use when user returns from payment - fallback if webhook hasn't arrived yet.
 * Returns { verified, data } where data has authorization (for card reuse) and status.
 */
export async function verifyTransaction(reference) {
  const secretKey = process.env.PAYSTACK_SECRET_KEY;
  if (!secretKey) throw new Error('PAYSTACK_SECRET_KEY is not set');
  const res = await fetch(`${PAYSTACK_BASE}/transaction/verify/${encodeURIComponent(reference)}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${secretKey}` },
  });
  const data = await res.json();
  if (!data.status) throw new Error(data.message || 'Transaction verification failed');
  const tx = data.data || {};
  return {
    verified: tx.status === 'success',
    data: tx,
    authorization: tx.authorization,
  };
}

/**
 * Refund a transaction (POST /refund)
 * Refunds to the original payment method.
 */
export async function refundTransaction(transaction, { amount, currency, reason } = {}) {
  const secretKey = process.env.PAYSTACK_SECRET_KEY;
  if (!secretKey) throw new Error('PAYSTACK_SECRET_KEY is not set');
  const body = { transaction: String(transaction) };
  if (amount != null) body.amount = Math.round(Number(amount) * 100);
  if (currency) body.currency = currency;
  if (reason) body.merchant_note = reason;
  const res = await fetch(`${PAYSTACK_BASE}/refund`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.status) throw new Error(data.message || 'Refund failed');
  return data.data;
}

/**
 * Create transfer recipient (M-Pesa)
 * POST /transferrecipient - type: mobile_money, bank_code: MPESA, account_number: phone
 */
export async function createTransferRecipient({ name, phone, currency = 'KES' }) {
  const secretKey = process.env.PAYSTACK_SECRET_KEY;
  if (!secretKey) throw new Error('PAYSTACK_SECRET_KEY is not set');
  let normalized = String(phone || '').replace(/\s/g, '').replace(/^\+/, '');
  if (normalized.startsWith('0')) normalized = '254' + normalized.slice(1);
  else if (!normalized.startsWith('254')) normalized = '254' + normalized;
  if (normalized.length < 12) throw new Error('Invalid phone number');
  const accountNumber = '0' + normalized.slice(3);
  const body = {
    type: 'mobile_money',
    name: name || 'Recipient',
    account_number: accountNumber,
    bank_code: 'MPESA',
    currency,
  };
  const res = await fetch(`${PAYSTACK_BASE}/transferrecipient`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.status) throw new Error(data.message || 'Create recipient failed');
  return data.data;
}

/**
 * Initiate transfer to recipient
 * POST /transfer
 */
export async function initiateTransfer({ amount, recipientCode, reference, reason, currency = 'KES' }) {
  const secretKey = process.env.PAYSTACK_SECRET_KEY;
  if (!secretKey) throw new Error('PAYSTACK_SECRET_KEY is not set');
  const amountInSmallest = Math.round(Number(amount) * 100);
  const ref = reference || `TRF-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const body = {
    source: 'balance',
    amount: amountInSmallest,
    recipient: recipientCode,
    reference: ref.slice(0, 50),
    currency,
  };
  if (reason) body.reason = String(reason).slice(0, 100);
  const res = await fetch(`${PAYSTACK_BASE}/transfer`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.status) throw new Error(data.message || 'Transfer failed');
  return data.data;
}

/**
 * Fetch transfer details
 * GET /transfer/:id
 */
export async function fetchTransfer(transferId) {
  const secretKey = process.env.PAYSTACK_SECRET_KEY;
  if (!secretKey) throw new Error('PAYSTACK_SECRET_KEY is not set');
  const res = await fetch(`${PAYSTACK_BASE}/transfer/${transferId}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${secretKey}` },
  });
  const data = await res.json();
  if (!data.status) throw new Error(data.message || 'Fetch transfer failed');
  return data.data;
}

/**
 * Charge returning customer with saved authorization (card only)
 * POST /charge with authorization_code
 */
export async function chargeAuthorization({ email, amount, authorizationCode, reference, currency = 'KES', metadata = {} }) {
  const secretKey = process.env.PAYSTACK_SECRET_KEY;
  if (!secretKey) throw new Error('PAYSTACK_SECRET_KEY is not set');
  const amountInSmallest = Math.round(Number(amount) * 100);
  const body = {
    email,
    amount: String(amountInSmallest),
    currency,
    authorization_code: authorizationCode,
    reference: reference || `APP-${Date.now()}`,
    metadata: { ...metadata, custom_fields: [] },
  };
  const res = await fetch(`${PAYSTACK_BASE}/charge`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  const d = data.data || {};
  if (!data.status) throw new Error(data.message || 'Charge failed');
  if (d.status === 'failed') {
    const reason = d.gateway_response || d.message || 'Payment could not be processed';
    throw new Error(reason);
  }
  return {
    reference: d.reference || reference,
    status: d.status,
    authorization: d.authorization,
  };
}

/**
 * Verify Paystack webhook signature (x-paystack-signature)
 * Returns false if secret is not configured (reject webhooks until properly set).
 */
export function verifyWebhookSignature(payload, signature) {
  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret || !signature) return false;
  const hash = crypto.createHmac('sha512', secret).update(payload).digest('hex');
  if (hash.length !== signature.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(signature, 'hex'));
  } catch {
    return false;
  }
}
