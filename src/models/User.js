import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true },
    password: { type: String, required: false }, // not set for Google-only users
    authProvider: { type: String, enum: ['email', 'google'], default: 'email' },
    googleId: { type: String, sparse: true },
    avatar: { type: String },
    cvUrl: { type: String },
    paystackAuthorizationCode: { type: String },
    paystackCardLast4: { type: String },
    paystackCardType: { type: String },
    role: { type: String, enum: ['student', 'graduate', 'admin'], default: 'student' },
    emailVerified: { type: Boolean, default: false },
    emailOTP: { type: String },
    emailOTPExpires: { type: Date },
    passwordResetToken: { type: String },
    passwordResetExpires: { type: Date },
    savedOpportunities: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Opportunity' }],
  },
  {
    timestamps: true,
    toJSON: {
      transform(doc, ret) {
        delete ret.paystackAuthorizationCode;
        ret.hasSavedCard = !!doc.paystackAuthorizationCode;
        return ret;
      },
    },
  }
);

userSchema.pre('save', async function (next) {
  if (!this.isModified('password') || !this.password) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

userSchema.methods.matchPassword = async function (candidate) {
  return bcrypt.compare(candidate, this.password);
};

export default mongoose.model('User', userSchema);
