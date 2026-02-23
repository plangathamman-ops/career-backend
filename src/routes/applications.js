import express from 'express';
import multer from 'multer';
import Application from '../models/Application.js';
import Opportunity from '../models/Opportunity.js';
import User from '../models/User.js';
import { protect, adminOnly } from '../middleware/auth.js';
import { uploadToCloudinary } from '../utils/cloudinary.js';
import {
  initializeTransaction,
  chargeMpesa,
  verifyTransaction,
  refundTransaction,
  createTransferRecipient,
  initiateTransfer,
  chargeAuthorization,
  verifyWebhookSignature,
} from '../utils/paystack.js';
import { validateDocFile } from '../utils/fileValidation.js';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// List my applications (frontend calls GET /applications)
router.get('/', protect, async (req, res) => {
  try {
    const apps = await Application.find({ userId: req.user._id })
      .populate('opportunityId', 'title company type deadline')
      .sort({ createdAt: -1 })
      .lean();
    res.json(apps);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Admin: list all applications
router.get('/admin/all', protect, adminOnly, async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    const skip = (page - 1) * limit;
    const [applications, total] = await Promise.all([
      Application.find({})
        .populate('opportunityId', 'title company type')
        .populate('userId', 'name email')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Application.countDocuments({}),
    ]);
    res.json({ applications, total, page, pages: Math.ceil(total / limit) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Admin: refund application (refunds to original payment method)
router.post('/admin/:id/refund', protect, adminOnly, async (req, res) => {
  try {
    const { reason } = req.body;
    const application = await Application.findOneAndUpdate(
      {
        _id: req.params.id,
        refundedAt: null,
      },
      { $set: { refundedAt: new Date() } },
      { new: true }
    )
      .populate('opportunityId')
      .populate('userId', 'name email');
    if (!application) return res.status(404).json({ message: 'Application not found or already refunded' });
    if (application.status !== 'submitted' && application.status !== 'under_review' && application.status !== 'shortlisted' && application.status !== 'rejected' && application.status !== 'accepted') {
      return res.status(400).json({ message: 'Cannot refund application that has not been paid' });
    }
    const txId = application.paymentTransactionId;
    if (!txId) {
      await Application.findByIdAndUpdate(application._id, { $unset: { refundedAt: 1 } });
      return res.status(400).json({ message: 'No payment transaction to refund' });
    }
    const amount = application.amountPaid ?? application.opportunityId?.applicationFee ?? 350;
    await refundTransaction(txId, { amount, currency: 'KES', reason: reason || `Refund for application ${application._id}` });
    await Application.findByIdAndUpdate(application._id, { $set: { refundAmount: amount } });
    res.json({ message: 'Refund initiated', refundAmount: amount });
  } catch (err) {
    res.status(400).json({ message: err.message || 'Refund failed' });
  }
});

// Admin: transfer to M-Pesa (e.g. refund to specific number)
router.post('/admin/transfer-mpesa', protect, adminOnly, async (req, res) => {
  try {
    const { amount, phone, name, reason, applicationId } = req.body;
    if (!amount || !phone) {
      return res.status(400).json({ message: 'Amount and phone number are required' });
    }
    const recipient = await createTransferRecipient({
      name: name || 'Recipient',
      phone,
      currency: 'KES',
    });
    const ref = applicationId ? `REF-${applicationId}-${Date.now()}` : `TRF-${Date.now()}`;
    const transfer = await initiateTransfer({
      amount: Number(amount),
      recipientCode: recipient.recipient_code,
      reference: ref,
      reason: reason || 'Refund',
      currency: 'KES',
    });
    if (applicationId) {
      const app = await Application.findById(applicationId);
      if (app) {
        app.refundedAt = new Date();
        app.refundAmount = Number(amount);
        app.refundTransferCode = transfer.transfer_code || transfer.id;
        await app.save();
      }
    }
    res.json({
      message: 'Transfer initiated',
      transferCode: transfer.transfer_code || transfer.id,
      status: transfer.status,
    });
  } catch (err) {
    res.status(400).json({ message: err.message || 'Transfer failed' });
  }
});

// Admin: update application status (e.g. after reviewing documents)
router.patch('/admin/:id/status', protect, adminOnly, async (req, res) => {
  try {
    const allowed = ['submitted', 'under_review', 'shortlisted', 'rejected', 'accepted'];
    const { status } = req.body;
    if (!status || !allowed.includes(status)) {
      return res.status(400).json({ message: 'Invalid status. Use: submitted, under_review, shortlisted, rejected, accepted' });
    }
    const application = await Application.findByIdAndUpdate(
      req.params.id,
      { status },
      { new: true }
    )
      .populate('opportunityId', 'title company type')
      .populate('userId', 'name email')
      .lean();
    if (!application) return res.status(404).json({ message: 'Application not found' });
    res.json(application);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.get('/my', protect, async (req, res) => {
  try {
    const apps = await Application.find({ userId: req.user._id })
      .populate('opportunityId', 'title company type deadline')
      .sort({ createdAt: -1 })
      .lean();
    res.json(apps);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// List my saved opportunities (returns array of opportunity documents)
router.get('/saved', protect, async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select('savedOpportunities').lean();
    const ids = user?.savedOpportunities || [];
    if (ids.length === 0) return res.json([]);
    const opportunities = await Opportunity.find({ _id: { $in: ids }, isActive: true }).lean();
    res.json(opportunities);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Helper: build Paystack callback URL and init payment for an application
async function getPaymentLink(application, opportunity, user) {
  const baseUrl = process.env.PAYSTACK_CALLBACK_URL || `${(process.env.FRONTEND_URL || '').replace(/\/$/, '')}/app/applications`;
  const callbackUrl = `${baseUrl}?payment=done&reference=APP-${application._id}`;
  const cancelUrl = `${baseUrl.split('?')[0]}?cancelled=1`;
  const reference = `APP-${application._id}-${Date.now()}`;
  const amount = opportunity?.applicationFee ?? 350;
  console.log('[Paystack] Initializing:', { reference, amount, callbackUrl: callbackUrl.slice(0, 60) + '...', email: user.email?.slice(0, 3) + '***' });
  const { paymentLink } = await initializeTransaction({
    reference,
    amount,
    currency: 'KES',
    callbackUrl,
    cancelUrl,
    customer: { email: user.email, name: user.name || 'Applicant' },
  });
  return paymentLink;
}

// Create application: upload resume (and recommendation letter for attachment), then return Paystack payment link
router.post(
  '/',
  protect,
  upload.fields([
    { name: 'resume', maxCount: 1 },
    { name: 'recommendationLetter', maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const { opportunityId, coverLetter } = req.body;
      const opportunity = await Opportunity.findById(opportunityId);
      if (!opportunity) return res.status(404).json({ message: 'Opportunity not found' });
      if (!opportunity.isActive) return res.status(400).json({ message: 'Opportunity is closed' });

      const existing = await Application.findOne({ userId: req.user._id, opportunityId });
      if (existing && existing.status !== 'pending_payment')
        return res.status(400).json({ message: 'You have already applied' });

      const resumeFile = req.files?.resume?.[0];
      if (!resumeFile) return res.status(400).json({ message: 'Resume is required' });
      const resumeCheck = validateDocFile(resumeFile);
      if (!resumeCheck.valid) return res.status(400).json({ message: resumeCheck.message });

      const isAttachment = opportunity.type === 'attachment';
      const recLetterFile = req.files?.recommendationLetter?.[0];
      if (isAttachment && !recLetterFile)
        return res.status(400).json({ message: 'Recommendation letter is required for attachments' });
      if (recLetterFile) {
        const recCheck = validateDocFile(recLetterFile);
        if (!recCheck.valid) return res.status(400).json({ message: recCheck.message });
      }

      const resumeUrl = await uploadToCloudinary(resumeFile.buffer, 'internship-platform/resumes');
      let recommendationLetterUrl = null;
      if (recLetterFile)
        recommendationLetterUrl = await uploadToCloudinary(
          recLetterFile.buffer,
          'internship-platform/recommendations'
        );

      let application;
      if (existing && existing.status === 'pending_payment') {
        existing.resumeUrl = resumeUrl;
        existing.recommendationLetterUrl = recLetterFile ? recommendationLetterUrl : existing.recommendationLetterUrl;
        existing.coverLetter = coverLetter || existing.coverLetter;
        await existing.save();
        application = existing;
      } else {
        application = await Application.create({
          userId: req.user._id,
          opportunityId,
          resumeUrl,
          recommendationLetterUrl,
          coverLetter: coverLetter || undefined,
          status: 'pending_payment',
        });
      }

      const paymentLink = await getPaymentLink(application, opportunity, req.user);
      res.status(200).json({
        application,
        paymentLink,
        requiresPayment: true,
        amount: opportunity.applicationFee ?? 350,
        message: 'Application saved. Complete payment via the link to finish.',
      });
    } catch (err) {
      console.error('[Paystack] Create application error:', err.message);
      res.status(500).json({ message: err.message });
    }
  }
);

// Paystack webhook handler (charge.success, transfer.success, transfer.failed)
export async function paystackWebhookHandler(req, res) {
  const rawBody = req.body?.toString?.() || (typeof req.body === 'string' ? req.body : '');
  const signature = req.headers['x-paystack-signature'];
  if (!verifyWebhookSignature(rawBody, signature)) {
    return res.status(401).json({ message: 'Invalid webhook signature' });
  }
  res.status(200).send();
  let body;
  try {
    body = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    return;
  }
  const event = body?.event;
  const data = body?.data;
  if (!data) return;

  if (event === 'charge.success') {
    const reference = data?.reference;
    const id = data?.id;
    const amount = data?.amount;
    const auth = data?.authorization;
    if (reference && reference.startsWith('APP-')) {
      const applicationId = reference.replace(/^APP-/, '').replace(/-\d+$/, '');
      const application = await Application.findById(applicationId);
      if (application && application.status === 'pending_payment') {
        application.status = 'submitted';
        application.paymentTransactionId = String(id ?? reference);
        if (amount != null) application.amountPaid = Number(amount) / 100;
        await application.save();
        if (application.userId && auth?.authorization_code && auth?.reusable) {
          await User.findByIdAndUpdate(application.userId, {
            paystackAuthorizationCode: auth.authorization_code,
            paystackCardLast4: auth?.last4 || null,
            paystackCardType: auth?.card_type || null,
          });
        }
      }
    }
    return;
  }

  if (event === 'transfer.success' || event === 'transfer.failed') {
    const transferCode = data?.transfer_code || data?.id;
    const status = data?.status;
    if (transferCode && status === 'success') {
      const app = await Application.findOne({ refundTransferCode: String(transferCode) });
      if (app) {
        app.refundedAt = new Date();
        await app.save();
      }
    }
  }
}

// Verify payment (call when user returns from Paystack with reference)
router.post('/verify-payment', protect, async (req, res) => {
  try {
    const { reference } = req.body;
    if (!reference || typeof reference !== 'string') {
      return res.status(400).json({ message: 'Reference is required' });
    }
    if (!reference.startsWith('APP-')) {
      return res.status(400).json({ message: 'Invalid reference' });
    }
    const result = await verifyTransaction(reference);
    if (!result.verified) {
      return res.json({ verified: false, message: 'Payment not completed' });
    }
    const applicationId = reference.replace(/^APP-/, '').replace(/-\d+$/, '');
    const application = await Application.findOne({
      _id: applicationId,
      userId: req.user._id,
      status: 'pending_payment',
    });
    if (application) {
      const tx = result.data || {};
      application.status = 'submitted';
      application.paymentTransactionId = String(tx.id ?? tx.reference ?? reference);
      if (tx.amount != null) application.amountPaid = Number(tx.amount) / 100;
      await application.save();
      const auth = result.authorization || tx.authorization;
      if (auth?.authorization_code && auth?.reusable) {
        await User.findByIdAndUpdate(req.user._id, {
          paystackAuthorizationCode: auth.authorization_code,
          paystackCardLast4: auth?.last4 || null,
          paystackCardType: auth?.card_type || null,
        });
      }
    }
    res.json({ verified: true });
  } catch (err) {
    res.status(400).json({ verified: false, message: err.message || 'Verification failed' });
  }
});

// Pay for existing pending_payment application (get new Paystack payment link)
router.post('/:id/pay', protect, async (req, res) => {
  try {
    const application = await Application.findOne({
      _id: req.params.id,
      userId: req.user._id,
      status: 'pending_payment',
    }).populate('opportunityId');
    if (!application) return res.status(404).json({ message: 'Application not found' });
    const paymentLink = await getPaymentLink(application, application.opportunityId, req.user);
    res.json({
      paymentLink,
      message: 'Complete payment via the link to finish your application.',
    });
  } catch (err) {
    console.error('[Paystack] Pay route error:', err.message);
    res.status(500).json({ message: err.message });
  }
});

// Charge with saved card (returning customer)
router.post('/:id/charge-saved-card', protect, async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select('paystackAuthorizationCode email name').lean();
    if (!user?.paystackAuthorizationCode) {
      return res.status(400).json({ message: 'No saved card. Please use Pay now or M-Pesa.' });
    }
    const application = await Application.findOne({
      _id: req.params.id,
      userId: req.user._id,
      status: 'pending_payment',
    }).populate('opportunityId');
    if (!application) return res.status(404).json({ message: 'Application not found' });
    const opp = application.opportunityId;
    const amount = opp?.applicationFee ?? 350;
    const reference = `APP-${application._id}-${Date.now()}`;
    const result = await chargeAuthorization({
      email: user.email,
      amount,
      authorizationCode: user.paystackAuthorizationCode,
      reference,
      currency: 'KES',
      metadata: { customer_name: user.name || 'Applicant' },
    });
    if (result.status === 'success') {
      application.status = 'submitted';
      application.paymentTransactionId = result.reference;
      application.amountPaid = amount;
      await application.save();
    }
    res.json({
      reference: result.reference,
      status: result.status,
      message: result.status === 'success' ? 'Payment successful.' : 'Charge initiated. Payment may take a moment to confirm.',
    });
  } catch (err) {
    res.status(400).json({ message: err.message || 'Charge failed' });
  }
});

// M-Pesa charge: user enters phone (07 or 254), we trigger STK push
router.post('/:id/charge-mpesa', protect, async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone || typeof phone !== 'string') {
      return res.status(400).json({ message: 'Phone number is required' });
    }
    const application = await Application.findOne({
      _id: req.params.id,
      userId: req.user._id,
      status: 'pending_payment',
    }).populate('opportunityId');
    if (!application) return res.status(404).json({ message: 'Application not found' });
    const opp = application.opportunityId;
    const reference = `APP-${application._id}-${Date.now()}`;
    const result = await chargeMpesa({
      reference,
      amount: opp?.applicationFee ?? 350,
      currency: 'KES',
      email: req.user.email,
      phone: phone.trim(),
      metadata: { customer_name: req.user.name || 'Applicant' },
    });
    res.json({
      reference: result.reference,
      status: result.status,
      display_text: result.display_text,
      message: result.display_text,
    });
  } catch (err) {
    res.status(400).json({ message: err.message || 'M-Pesa charge failed' });
  }
});

// Frontend: get one application (own only)
router.get('/:id', protect, async (req, res) => {
  try {
    const app = await Application.findOne({
      _id: req.params.id,
      userId: req.user._id,
    })
      .populate('opportunityId', 'title company type deadline')
      .lean();
    if (!app) return res.status(404).json({ message: 'Application not found' });
    res.json(app);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Frontend: update application (e.g. cover letter; only when pending)
router.patch('/:id', protect, async (req, res) => {
  try {
    const application = await Application.findOne({
      _id: req.params.id,
      userId: req.user._id,
    });
    if (!application) return res.status(404).json({ message: 'Application not found' });
    if (application.status !== 'pending_payment' && application.status !== 'submitted') {
      return res.status(400).json({ message: 'Application can no longer be updated' });
    }
    const { coverLetter } = req.body;
    if (coverLetter !== undefined) application.coverLetter = coverLetter;
    await application.save();
    const updated = await Application.findById(application._id)
      .populate('opportunityId', 'title company type deadline')
      .lean();
    res.json(updated);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Frontend: withdraw application (only when pending_payment or submitted)
router.delete('/:id', protect, async (req, res) => {
  try {
    const application = await Application.findOne({
      _id: req.params.id,
      userId: req.user._id,
    });
    if (!application) return res.status(404).json({ message: 'Application not found' });
    const allowed = ['pending_payment', 'submitted'];
    if (!allowed.includes(application.status)) {
      return res.status(400).json({ message: 'Application cannot be withdrawn' });
    }
    await Application.findByIdAndDelete(application._id);
    res.json({ message: 'Application withdrawn' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

export default router;
