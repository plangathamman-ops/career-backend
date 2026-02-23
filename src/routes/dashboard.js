import express from 'express';
import Opportunity from '../models/Opportunity.js';
import Application from '../models/Application.js';
import { protect } from '../middleware/auth.js';

const router = express.Router();

// GET /dashboard/stats — counts for dashboard (admin sees all; student sees own)
router.get('/stats', protect, async (req, res) => {
  try {
    const isAdmin = req.user.role === 'admin';
    const [opportunitiesCount, applicationsCount, myApplicationsCount] = await Promise.all([
      Opportunity.countDocuments(isAdmin ? {} : { isActive: true }),
      isAdmin ? Application.countDocuments() : Application.countDocuments({ userId: req.user._id }),
      Application.countDocuments({ userId: req.user._id }),
    ]);
    res.json({
      opportunities: opportunitiesCount,
      applications: applicationsCount,
      myApplications: myApplicationsCount,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /dashboard/activity — recent activity (e.g. recent applications)
router.get('/activity', protect, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 10, 50);
    const apps = await Application.find({ userId: req.user._id })
      .populate('opportunityId', 'title company')
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();
    const activity = apps.map((a) => ({
      id: a._id,
      type: 'application',
      createdAt: a.createdAt,
      opportunity: a.opportunityId,
      status: a.status,
    }));
    res.json(activity);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

export default router;
