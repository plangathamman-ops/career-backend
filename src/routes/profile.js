import express from 'express';
import multer from 'multer';
import User from '../models/User.js';
import { protect } from '../middleware/auth.js';
import { uploadToCloudinary } from '../utils/cloudinary.js';
import { validateDocFile } from '../utils/fileValidation.js';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// GET /profile — same as auth/me (frontend compatibility)
router.get('/', protect, async (req, res) => {
  res.json(req.user);
});

// PATCH /profile — update name, email, etc.
router.patch('/', protect, async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select('-password');
    if (!user) return res.status(401).json({ message: 'User not found' });
    const { name, email } = req.body;
    if (name !== undefined) user.name = name;
    if (email !== undefined) user.email = email;
    await user.save();
    const out = user.toObject();
    delete out.password;
    res.json(out);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /profile/cv — upload CV and save URL on user
router.post('/cv', protect, upload.single('cv'), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ message: 'CV file is required' });
    const fileCheck = validateDocFile(file);
    if (!fileCheck.valid) return res.status(400).json({ message: fileCheck.message });
    const cvUrl = await uploadToCloudinary(file.buffer, 'internship-platform/cvs');
    const user = await User.findById(req.user._id);
    if (!user) return res.status(401).json({ message: 'User not found' });
    user.cvUrl = cvUrl;
    await user.save();
    const out = user.toObject();
    delete out.password;
    res.json(out);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

export default router;
