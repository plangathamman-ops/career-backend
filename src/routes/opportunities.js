import express from 'express';
import escapeStringRegexp from 'escape-string-regexp';
import Opportunity from '../models/Opportunity.js';
import User from '../models/User.js';
import { protect, adminOnly } from '../middleware/auth.js';
import { body, validationResult } from 'express-validator';

const router = express.Router();

function safeRegex(str) {
  if (!str || typeof str !== 'string') return null;
  try {
    return new RegExp(escapeStringRegexp(str.trim()), 'i');
  } catch {
    return null;
  }
}

// Admin: list all opportunities (including inactive)
router.get('/admin/all', protect, adminOnly, async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    const skip = (page - 1) * limit;
    const [opportunities, total] = await Promise.all([
      Opportunity.find({}).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Opportunity.countDocuments({}),
    ]);
    res.json({ opportunities, total, page, pages: Math.ceil(total / limit) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.get('/', async (req, res) => {
  try {
    const { category, location, type, duration, search } = req.query;
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 12));
    const filter = { isActive: true };
    const catRe = safeRegex(category);
    if (catRe) filter.category = catRe;
    const locRe = safeRegex(location);
    if (locRe) filter.location = locRe;
    if (type) filter.type = type;
    const durRe = safeRegex(duration);
    if (durRe) filter.duration = durRe;
    const searchRe = safeRegex(search);
    if (searchRe) {
      filter.$or = [
        { title: searchRe },
        { company: searchRe },
        { description: searchRe },
      ];
    }
    const skip = (page - 1) * limit;
    const [opportunities, total] = await Promise.all([
      Opportunity.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Opportunity.countDocuments(filter),
    ]);
    res.json({ opportunities, total, page, pages: Math.ceil(total / limit) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Frontend: recommended opportunities (e.g. latest 6)
router.get('/recommended', async (req, res) => {
  try {
    const opportunities = await Opportunity.find({ isActive: true })
      .sort({ createdAt: -1 })
      .limit(6)
      .lean();
    res.json(opportunities);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Frontend: list current user's saved opportunities
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

// Toggle save opportunity for current user (must be before GET /:id)
router.post('/:id/save', protect, async (req, res) => {
  try {
    const opp = await Opportunity.findById(req.params.id);
    if (!opp) return res.status(404).json({ message: 'Opportunity not found' });
    const user = await User.findById(req.user._id).select('savedOpportunities');
    if (!user) return res.status(401).json({ message: 'User not found' });
    const id = opp._id;
    const list = user.savedOpportunities || [];
    const idx = list.findIndex((s) => s.toString() === id.toString());
    if (idx >= 0) {
      list.splice(idx, 1);
      user.savedOpportunities = list;
      await user.save();
      return res.json({ saved: false });
    }
    list.push(id);
    user.savedOpportunities = list;
    await user.save();
    res.json({ saved: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Frontend: unsave opportunity (DELETE instead of toggle)
router.delete('/:id/save', protect, async (req, res) => {
  try {
    const opp = await Opportunity.findById(req.params.id);
    if (!opp) return res.status(404).json({ message: 'Opportunity not found' });
    const user = await User.findById(req.user._id).select('savedOpportunities');
    if (!user) return res.status(401).json({ message: 'User not found' });
    const id = opp._id;
    const list = user.savedOpportunities || [];
    const idx = list.findIndex((s) => s.toString() === id.toString());
    if (idx >= 0) {
      list.splice(idx, 1);
      user.savedOpportunities = list;
      await user.save();
    }
    res.json({ saved: false });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const opp = await Opportunity.findById(req.params.id).lean();
    if (!opp) return res.status(404).json({ message: 'Opportunity not found' });
    res.json(opp);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.post(
  '/',
  protect,
  adminOnly,
  [
    body('title').trim().notEmpty(),
    body('company').trim().notEmpty(),
    body('type').isIn(['internship', 'attachment']),
    body('description').trim().notEmpty(),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
      const opportunity = await Opportunity.create(req.body);
      res.status(201).json(opportunity);
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  }
);

const PATCH_WHITELIST = ['title', 'company', 'type', 'description', 'location', 'duration', 'applicationFee', 'isActive', 'deadline', 'category'];
router.patch('/:id', protect, adminOnly, async (req, res) => {
  try {
    const updates = {};
    for (const k of PATCH_WHITELIST) {
      if (req.body[k] !== undefined) updates[k] = req.body[k];
    }
    if (Object.keys(updates).length === 0) return res.status(400).json({ message: 'No valid fields to update' });
    const opportunity = await Opportunity.findByIdAndUpdate(
      req.params.id,
      updates,
      { new: true }
    );
    if (!opportunity) return res.status(404).json({ message: 'Opportunity not found' });
    res.json(opportunity);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

export default router;
