import express from 'express';
import { protect } from '../middleware/auth.js';

const router = express.Router();

// Stub routes for frontend compatibility (no Message model yet).
// GET /messages — return empty list
router.get('/', protect, (req, res) => {
  res.json([]);
});

// GET /messages/:id — 404
router.get('/:id', protect, (req, res) => {
  res.status(404).json({ message: 'Message not found' });
});

// POST /messages — accept and return stub
router.post('/', protect, (req, res) => {
  res.status(201).json({
    _id: req.user._id,
    message: 'Messages not implemented',
  });
});

// PATCH /messages/:id/read — 200
router.patch('/:id/read', protect, (req, res) => {
  res.json({ read: true });
});

export default router;
