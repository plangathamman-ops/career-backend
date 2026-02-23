# Paystack Setup Guide

Use this guide to configure Paystack for live payments on your IAS platform.

---

## 1. Get your API keys

1. Log in to [Paystack Dashboard](https://dashboard.paystack.com)
2. Go to **Settings** → **API Keys & Webhooks**
3. Copy your **Live** keys (for production):
   - **Public key** → `PAYSTACK_PUBLIC_KEY` (pk_live_xxx)
   - **Secret key** → `PAYSTACK_SECRET_KEY` (sk_live_xxx)

For testing, use **Test** keys (pk_test_xxx and sk_test_xxx).

---

## 2. Add keys to .env

Edit `backend/.env` and set:

```env
PAYSTACK_PUBLIC_KEY=pk_live_your_public_key_here
PAYSTACK_SECRET_KEY=sk_live_your_secret_key_here
```

Optional: if your frontend lives at a different URL, set the callback URL:

```env
PAYSTACK_CALLBACK_URL=https://your-frontend-domain.com/app/applications
```

If not set, it defaults to `FRONTEND_URL/app/applications`.

---

## 3. Set up webhook in Paystack

1. In Paystack Dashboard → **Settings** → **API Keys & Webhooks**
2. Find **Webhook URL**
3. Enter your webhook URL:

   ```
   https://your-backend-domain.com/api/applications/paystack-webhook
   ```

   Replace `your-backend-domain.com` with your actual backend URL (e.g. `api.hamanmatage.com`).

4. Save the webhook URL

Paystack will send these events to this URL:

- **charge.success** — Payment completed. App updates application status and stores card authorization (for "Pay with saved card") if reusable.
- **transfer.success** / **transfer.failed** — Transfer status (for admin M-Pesa transfers/refunds).

---

## 4. Enable KES (Kenyan Shillings)

If you use Kenyan Shillings (KES):

1. In Paystack Dashboard → **Settings** → **Business**
2. Ensure **KES** is enabled for your account
3. Your settlement currency should be set correctly

---

## 5. Go live checklist

- [ ] API keys: using **Live** keys (pk_live_*, sk_live_*) in production
- [ ] Webhook URL: set and reachable from the internet (HTTPS)
- [ ] FRONTEND_URL: correct in .env (for redirect after payment)
- [ ] Test: create an application, pay, and confirm the application status updates to "Submitted"

---

## 6. Testing (optional)

Use **Test** keys first:

1. Use pk_test_* and sk_test_* in .env
2. Use Paystack’s test cards:  
   - Card: `4084 0840 8408 4081`  
   - CVV: any 3 digits  
   - Expiry: any future date  
3. After testing, switch to Live keys for production

---

## Implemented features

| Feature | Description |
|---------|-------------|
| **Initialize** | Redirect users to Paystack hosted page (Card/M-Pesa) |
| **Verify** | When user returns from payment, backend verifies via API (fallback if webhook delayed) |
| **M-Pesa Charge** | STK push for M-Pesa payments |
| **Charge returning customer** | "Pay with saved card" — reuses stored authorization from first card payment |
| **Refund** | Admin-only: refund to original payment method via Paystack Refund API |
| **Transfers** | Admin-only: send to M-Pesa via Create Recipient + Initiate Transfer |

---

## Summary

| Variable               | Where to get it                          |
|------------------------|------------------------------------------|
| PAYSTACK_PUBLIC_KEY    | Dashboard → Settings → API Keys (Public) |
| PAYSTACK_SECRET_KEY    | Dashboard → Settings → API Keys (Secret) |
| Webhook URL to set     | `https://YOUR-BACKEND/api/applications/paystack-webhook` |
