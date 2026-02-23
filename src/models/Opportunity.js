import mongoose from 'mongoose';

const opportunitySchema = new mongoose.Schema(
  {
    title: { type: String, required: true },
    company: { type: String, required: true },
    companyLogo: { type: String },
    type: { type: String, enum: ['internship', 'attachment'], required: true },
    description: { type: String, required: true },
    requirements: [{ type: String }],
    location: { type: String },
    duration: { type: String },
    category: { type: String },
    applicationFee: { type: Number, default: 500 },
    deadline: { type: Date },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

export default mongoose.model('Opportunity', opportunitySchema);
