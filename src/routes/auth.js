import express from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { body, validationResult } from 'express-validator';
import { OAuth2Client } from 'google-auth-library';
import User from '../models/User.js';
import { protect } from '../middleware/auth.js';
import { sendOTPEmail, sendPasswordResetEmail } from '../utils/sendEmail.js';
import { generateOTP, hashOTP } from '../utils/otp.js';

const router = express.Router();
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

function generateToken(id) {
  return jwt.sign({ id }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
    algorithm: 'HS256',
  });
}

router.post(
  '/register',
  [
    body('name').trim().notEmpty().withMessage('Name is required'),
    body('email').isEmail().normalizeEmail(),
    body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
    body('role').optional().isIn(['student', 'graduate']).withMessage('Role must be student or graduate'),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
      const { name, email, password, role: bodyRole } = req.body;
      const existing = await User.findOne({ email });
      if (existing) return res.status(400).json({ message: 'Email already registered' });
      const isAdmin = process.env.ADMIN_EMAIL && email.toLowerCase() === process.env.ADMIN_EMAIL.toLowerCase();
      const role = isAdmin ? 'admin' : (bodyRole === 'graduate' ? 'graduate' : 'student');
      const otp = generateOTP();
      const user = await User.create({
        name,
        email,
        password,
        authProvider: 'email',
        role,
        emailOTP: hashOTP(otp),
        emailOTPExpires: new Date(Date.now() + 10 * 60 * 1000), // 10 min
      });
      const emailSent = await sendOTPEmail(user.email, otp);
      const u = { _id: user._id, name: user.name, email: user.email, role: user.role, avatar: user.avatar, emailVerified: user.emailVerified };
      res.status(201).json({
        user: u,
        verificationEmailSent: emailSent,
        message: emailSent ? 'OTP sent to your email. Please verify.' : 'Account created. OTP email could not be sent (SMTP not configured). Please contact support.',
      });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  }
);

router.post(
  '/login',
  [body('email').isEmail().normalizeEmail(), body('password').notEmpty()],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
      const { email, password } = req.body;
      const user = await User.findOne({ email });
      if (!user || !user.password) return res.status(401).json({ message: 'Invalid credentials' });
      const match = await user.matchPassword(password);
      if (!match) return res.status(401).json({ message: 'Invalid credentials' });
      if (!user.emailVerified) {
        return res.status(403).json({ message: 'Please verify your email first' });
      }
      const u = { _id: user._id, name: user.name, email: user.email, role: user.role, avatar: user.avatar, emailVerified: user.emailVerified };
      res.json({ user: u, token: generateToken(user._id) });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  }
);

router.post('/google', async (req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    return res.status(500).json({ message: 'Google sign-in is not configured (missing GOOGLE_CLIENT_ID)' });
  }
  try {
    const idToken = req.body.idToken;
    const accessToken = req.body.accessToken;
    const bodyRole = req.body.role; // 'student' | 'graduate' — used only when creating a new user
    let payload;
    if (idToken) {
      const ticket = await googleClient.verifyIdToken({
        idToken,
        audience: clientId,
      });
      payload = ticket.getPayload();
    } else if (accessToken) {
      const r = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!r.ok) return res.status(401).json({ message: 'Invalid Google token' });
      const userinfo = await r.json();
      payload = { sub: userinfo.sub, name: userinfo.name, email: userinfo.email, picture: userinfo.picture };
    } else {
      return res.status(400).json({ message: 'idToken or accessToken required' });
    }
    const { sub: googleId, name, email, picture } = payload;
    let user = await User.findOne({ $or: [{ googleId }, { email }] });
    if (!user) {
      const isAdmin = process.env.ADMIN_EMAIL && email.toLowerCase() === process.env.ADMIN_EMAIL.toLowerCase();
      const role = isAdmin ? 'admin' : (bodyRole === 'graduate' ? 'graduate' : 'student');
      user = await User.create({
        name,
        email,
        googleId,
        avatar: picture,
        authProvider: 'google',
        role,
        emailVerified: true,
      });
    } else {
      if (!user.googleId) {
        user.googleId = googleId;
        user.avatar = user.avatar || picture;
      }
      user.emailVerified = true;
      await user.save();
    }
    const u = { _id: user._id, name: user.name, email: user.email, role: user.role, avatar: user.avatar, emailVerified: user.emailVerified };
    res.json({ user: u, token: generateToken(user._id) });
  } catch (err) {
    console.error('Google sign-in error:', err.message);
    const message =
      err.message?.includes('audience') || err.message?.includes('Audience')
        ? 'Google client ID mismatch. Use the same OAuth client ID in frontend (VITE_GOOGLE_CLIENT_ID) and backend (GOOGLE_CLIENT_ID), and add your site URL to Authorized JavaScript origins in Google Cloud Console.'
        : err.message?.includes('expired')
          ? 'Google sign-in expired. Try again.'
          : 'Invalid Google token. Check that your site is in Authorized JavaScript origins in Google Cloud Console.';
    res.status(401).json({ message });
  }
});

// POST /forgot-password — send reset link to email
router.post(
  '/forgot-password',
  [body('email').isEmail().normalizeEmail()],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
      const { email } = req.body;
      const user = await User.findOne({ email, authProvider: 'email' });
      // Always return success to prevent email enumeration
      if (!user || !user.password) {
        return res.json({ message: 'If an account exists with that email, a reset link has been sent.' });
      }
      const resetToken = crypto.randomBytes(32).toString('hex');
      user.passwordResetToken = resetToken;
      user.passwordResetExpires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
      await user.save();
      const frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');
      const resetUrl = `${frontendUrl}/reset-password?token=${resetToken}`;
      const result = await sendPasswordResetEmail(user.email, user.name, resetUrl);
      const isDev = process.env.NODE_ENV !== 'production';
      res.json({
        message: result.ok
          ? 'If an account exists with that email, a reset link has been sent.'
          : 'Password reset requested. If email delivery fails, try again later or contact support.',
        ...(isDev && !result.ok && result.error && { smtpError: result.error }),
      });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  }
);

// POST /reset-password — set new password using token from email link
router.post(
  '/reset-password',
  [
    body('token').notEmpty().withMessage('Token is required'),
    body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
      const { token, password } = req.body;
      const user = await User.findOne({
        passwordResetToken: token,
        passwordResetExpires: { $gt: new Date() },
      });
      if (!user) {
        return res.status(400).json({ message: 'Invalid or expired reset token. Please request a new link.' });
      }
      user.password = password;
      user.passwordResetToken = undefined;
      user.passwordResetExpires = undefined;
      await user.save();
      res.json({ message: 'Password updated. You can now log in.' });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  }
);

// POST /verify-email — verify OTP (body: { email, otp })
router.post(
  '/verify-email',
  [
    body('email').isEmail().normalizeEmail(),
    body('otp').isLength({ min: 6, max: 6 }).withMessage('OTP must be 6 digits'),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
      const { email, otp } = req.body;
      const hashedOTP = hashOTP(otp);
      const user = await User.findOne({
        email,
        authProvider: 'email',
        emailOTP: hashedOTP,
        emailOTPExpires: { $gt: new Date() },
      });
      if (!user) {
        return res.status(400).json({ message: 'Invalid or expired OTP' });
      }
      user.emailVerified = true;
      user.emailOTP = undefined;
      user.emailOTPExpires = undefined;
      await user.save();
      const u = { _id: user._id, name: user.name, email: user.email, role: user.role, avatar: user.avatar, emailVerified: true };
      res.json({
        message: 'Email verified successfully',
        user: u,
        token: generateToken(user._id),
      });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  }
);

// POST /resend-verification — resend OTP (body: { email } or auth header)
router.post(
  '/resend-verification',
  [body('email').optional().isEmail().normalizeEmail()],
  async (req, res) => {
    try {
      let user;
      if (req.body.email) {
        user = await User.findOne({ email: req.body.email, authProvider: 'email' });
      } else {
        const token = req.headers.authorization?.replace('Bearer ', '');
        if (token) {
          try {
            const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
            user = await User.findById(decoded.id);
          } catch {
            user = null;
          }
        }
      }
      if (!user || user.emailVerified) {
        return res.json({ message: 'If the account exists and is unverified, a verification OTP has been sent.' });
      }
      // Rate limit: 60s cooldown between resends
      const otpSentAt = user.emailOTPExpires ? user.emailOTPExpires.getTime() - 10 * 60 * 1000 : 0;
      if (otpSentAt > Date.now() - 60000) {
        return res.status(429).json({ message: 'Please wait a moment before requesting another code.' });
      }
      const otp = generateOTP();
      user.emailOTP = hashOTP(otp);
      user.emailOTPExpires = new Date(Date.now() + 10 * 60 * 1000); // 10 min
      await user.save();
      const sent = await sendOTPEmail(user.email, otp);
      res.json({
        message: sent
          ? 'Verification OTP sent. Please check your inbox.'
          : 'Could not send OTP. Please try again later.',
      });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  }
);

router.get('/me', protect, async (req, res) => {
  res.json(req.user);
});

// Frontend compatibility: logout (stateless JWT — client clears token)
router.post('/logout', (req, res) => {
  res.json({ ok: true });
});

// Frontend compatibility: refresh — return current user and new token
router.post('/refresh', protect, async (req, res) => {
  const user = req.user;
  const u = { _id: user._id, name: user.name, email: user.email, role: user.role, avatar: user.avatar, emailVerified: user.emailVerified };
  res.json({ user: u, token: generateToken(user._id) });
});

export default router;
