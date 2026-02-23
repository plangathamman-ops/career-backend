import nodemailer from 'nodemailer';

/**
 * Create a transporter. Uses SMTP env vars:
 * - SMTP_HOST (e.g. smtp.gmail.com)
 * - SMTP_PORT (e.g. 587)
 * - SMTP_USER (e.g. your-email@gmail.com)
 * - SMTP_PASS (e.g. Gmail App Password — spaces are trimmed)
 * If not set, returns null and send functions will no-op.
 */
function createTransporter() {
  const host = process.env.SMTP_HOST;
  const port = process.env.SMTP_PORT || 587;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS ? String(process.env.SMTP_PASS).replace(/\s/g, '') : '';
  if (!host || !user || !pass) return null;
  const portNum = Number(port);
  return nodemailer.createTransport({
    host,
    port: portNum,
    secure: portNum === 465,
    auth: { user, pass },
    // Gmail port 587 uses STARTTLS; ensure TLS is required
    ...(portNum === 587 && { requireTLS: true }),
  });
}

/**
 * Send verification email to the user.
 * @param {string} to - Email address
 * @param {string} name - User name
 * @param {string} verificationUrl - Full URL to click (e.g. https://api.example.com/api/auth/verify-email?token=xxx)
 * @returns {Promise<boolean>} - true if sent, false if SMTP not configured or send failed
 */
export async function sendVerificationEmail(to, name, verificationUrl) {
  const transporter = createTransporter();
  if (!transporter) {
    console.warn('Email verification skipped: SMTP not configured (set SMTP_HOST, SMTP_USER, SMTP_PASS)');
    return false;
  }
  try {
    await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to,
      subject: 'Verify your email — IAS Platform',
      text: `Hi ${name},\n\nPlease verify your email by clicking this link:\n${verificationUrl}\n\nThe link expires in 24 hours.\n\n— IAS Platform`,
      html: `
        <p>Hi ${name},</p>
        <p>Please verify your email by clicking the link below:</p>
        <p><a href="${verificationUrl}">Verify my email</a></p>
        <p>The link expires in 24 hours.</p>
        <p>— IAS Platform</p>
      `,
    });
    return true;
  } catch (err) {
    console.error('Send verification email error:', err.message);
    return false;
  }
}

/**
 * Send OTP verification email.
 * @param {string} to - Email address
 * @param {string} otp - 6-digit OTP (plain text, sent in email)
 * @returns {Promise<boolean>} - true if sent, false otherwise
 */
export async function sendOTPEmail(to, otp) {
  const transporter = createTransporter();
  if (!transporter) {
    console.warn('OTP email skipped: SMTP not configured');
    return false;
  }
  try {
    await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to,
      subject: 'Verify your email — IAS Platform',
      text: `Your verification code is: ${otp}\n\nThis code expires in 10 minutes.\n\n— IAS Platform`,
      html: `
        <h2>Email Verification</h2>
        <p>Your verification code is:</p>
        <h1 style="font-size: 32px; letter-spacing: 4px; margin: 16px 0;">${otp}</h1>
        <p>This code expires in 10 minutes.</p>
        <p>— IAS Platform</p>
      `,
    });
    return true;
  } catch (err) {
    console.error('Send OTP email error:', err.message);
    return false;
  }
}

/**
 * Send password reset email.
 * @param {string} to - Email address
 * @param {string} name - User name
 * @param {string} resetUrl - Full URL to click (e.g. https://app.example.com/reset-password?token=xxx)
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function sendPasswordResetEmail(to, name, resetUrl) {
  const transporter = createTransporter();
  if (!transporter) {
    const msg = 'SMTP not configured. Check SMTP_HOST, SMTP_USER, SMTP_PASS in .env';
    console.error('[SMTP]', msg);
    return { ok: false, error: msg };
  }
  try {
    await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to,
      subject: 'Reset your password — IAS Platform',
      text: `Hi ${name},\n\nYou requested a password reset. Click this link to set a new password:\n${resetUrl}\n\nThe link expires in 1 hour.\n\nIf you didn't request this, you can ignore this email.\n\n— IAS Platform`,
      html: `
        <p>Hi ${name},</p>
        <p>You requested a password reset. Click the link below to set a new password:</p>
        <p><a href="${resetUrl}">Reset my password</a></p>
        <p>The link expires in 1 hour.</p>
        <p>If you didn't request this, you can safely ignore this email.</p>
        <p>— IAS Platform</p>
      `,
    });
    return { ok: true };
  } catch (err) {
    const msg = err.message || String(err);
    console.error('[SMTP] Password reset email failed:', msg);
    if (err.response) console.error('[SMTP] Response:', err.response);
    if (err.code) console.error('[SMTP] Code:', err.code);
    return { ok: false, error: msg };
  }
}
