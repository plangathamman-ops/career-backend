/**
 * Quick SMTP test. Run from backend folder: node test-smtp.js YOUR_EMAIL
 * Ensure .env is loaded (e.g. dotenv or run with env vars).
 */
import 'dotenv/config';
import nodemailer from 'nodemailer';

const to = process.argv[2] || process.env.SMTP_USER;
if (!to) {
  console.log('Usage: node test-smtp.js your@email.com');
  process.exit(1);
}

const host = process.env.SMTP_HOST;
const port = Number(process.env.SMTP_PORT || 587);
const user = process.env.SMTP_USER;
const pass = process.env.SMTP_PASS ? String(process.env.SMTP_PASS).replace(/\s/g, '') : '';

console.log('Testing SMTP...');
console.log('Host:', host, '| Port:', port, '| User:', user, '| Pass set:', !!pass);

if (!host || !user || !pass) {
  console.error('Missing SMTP_HOST, SMTP_USER, or SMTP_PASS in .env');
  process.exit(1);
}

const transporter = nodemailer.createTransport({
  host,
  port,
  secure: port === 465,
  auth: { user, pass },
  ...(port === 587 && { requireTLS: true }),
});

transporter.sendMail({
  from: process.env.SMTP_FROM || user,
  to,
  subject: 'SMTP Test — IAS',
  text: 'If you got this, SMTP is working.',
})
  .then(() => console.log('SUCCESS: Email sent to', to))
  .catch((err) => {
    console.error('FAILED:', err.message);
    if (err.code) console.error('Code:', err.code);
    if (err.response) console.error('Response:', err.response);
    process.exit(1);
  });
