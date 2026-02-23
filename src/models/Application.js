import mongoose from 'mongoose';

const applicationSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    opportunityId: { type: mongoose.Schema.Types.ObjectId, ref: 'Opportunity', required: true },
    resumeUrl: { type: String, required: true },
    recommendationLetterUrl: { type: String }, // required for attachment type
    coverLetter: { type: String },
    status: {
      type: String,
      enum: ['pending_payment', 'submitted', 'under_review', 'shortlisted', 'rejected', 'accepted'],
      default: 'pending_payment',
    },
    mpesaCheckoutRequestId: { type: String }, // legacy
    mpesaTransactionId: { type: String }, // legacy
    paymentTransactionId: { type: String },
    amountPaid: { type: Number },
    refundedAt: { type: Date },
    refundTransferCode: { type: String },
    refundAmount: { type: Number },
  },
  { timestamps: true }
);

applicationSchema.index({ userId: 1, opportunityId: 1 }, { unique: true });

export default mongoose.model('Application', applicationSchema);
