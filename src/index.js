import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { connectDB } from './config/db.js';
import authRoutes from './routes/auth.js';
import opportunityRoutes from './routes/opportunities.js';
import applicationRoutes, { paystackWebhookHandler } from './routes/applications.js';
import profileRoutes from './routes/profile.js';
import dashboardRoutes from './routes/dashboard.js';
import messageRoutes from './routes/messages.js';
import { notFound, errorHandler } from './middleware/error.js';

const app = express();
const PORT = process.env.PORT || 5000;

app.set('trust proxy', 1);
app.use(cors({ origin: process.env.FRONTEND_URL || 'http://localhost:3000', credentials: true }));

// Rate limiting: general API (100 req/15min), auth stricter (20 req/15min)
const apiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100, standardHeaders: true, legacyHeaders: false });
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false });
app.use('/api/', apiLimiter);
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);

// Paystack webhook MUST receive raw body for signature verification — register before express.json()
app.post('/api/applications/paystack-webhook', express.raw({ type: 'application/json' }), paystackWebhookHandler);

app.use(express.json());

// Health check (for Railway)
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use('/api/auth', authRoutes);
app.use('/api/opportunities', opportunityRoutes);
app.use('/api/applications', applicationRoutes);
app.use('/api/profile', profileRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/messages', messageRoutes);

app.use(notFound);
app.use(errorHandler);

const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// Connect to DB without blocking server startup
connectDB().catch(err => {
  console.error('MongoDB connection failed:', err.message);
  // Server keeps running, Railway health check passes
});
