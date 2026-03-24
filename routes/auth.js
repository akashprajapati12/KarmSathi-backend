const express = require('express');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Site = require('../models/Site');
const auth = require('../middleware/auth');
const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
    service: 'gmail', // Configurable email service
    auth: {
        user: process.env.EMAIL_USER || '',
        pass: process.env.EMAIL_PASS || ''
    }
});

const router = express.Router();

// Helper: sign JWT with full role context
const signToken = (user) => {
    return jwt.sign(
        {
            userId: user._id,
            role: user.role,
            ownerId: user.ownerId ? user.ownerId.toString() : null
        },
        process.env.JWT_SECRET,
        { expiresIn: '7d' }
    );
};

// @route   POST /api/auth/register
// @desc    Register a new Owner account (public)
// @access  Public
router.post('/register', async (req, res) => {
    try {
        const { name, username, email, password } = req.body;

        // Check if user already exists
        const existingUser = await User.findOne({ $or: [{ email }, { username }] });
        if (existingUser) {
            return res.status(400).json({ message: 'User with that email or username already exists' });
        }

        // All public registrations are Owners
        const user = new User({ name, username, email, password, role: 'Owner', ownerId: null });
        await user.save();

        const token = signToken(user);

        res.status(201).json({
            message: 'User registered successfully',
            token,
            user: {
                id: user._id,
                name: user.name,
                username: user.username,
                email: user.email,
                role: user.role
            }
        });
    } catch (error) {
        console.error('Registration error:', error);
        res.status(500).json({ message: 'Server error during registration' });
    }
});

// @route   POST /api/auth/login
// @desc    Login for both Owner and Manager
// @access  Public
router.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        const user = await User.findOne({ email });
        if (!user) {
            return res.status(401).json({ message: 'Invalid credentials' });
        }

        const isMatch = await user.comparePassword(password);
        if (!isMatch) {
            return res.status(401).json({ message: 'Invalid credentials' });
        }

        const token = signToken(user);

        res.json({
            message: 'Login successful',
            token,
            user: {
                id: user._id,
                name: user.name,
                username: user.username,
                email: user.email,
                role: user.role,
                ownerId: user.ownerId || null
            }
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ message: 'Server error during login: ' + error.message });
    }
});

// @route   POST /api/auth/managers
// @desc    Owner creates a Manager account and optionally assigns to sites
// @access  Private (Owner only)
router.post('/managers', auth, async (req, res) => {
    try {
        // Only Owners can create managers
        if (req.user.role !== 'Owner') {
            return res.status(403).json({ message: 'Only Owners can create manager accounts' });
        }

        const { name, username, email, password, siteIds } = req.body;

        if (!name || !username || !email || !password) {
            return res.status(400).json({ message: 'Name, username, email, and password are required' });
        }

        // Check uniqueness
        const existing = await User.findOne({ $or: [{ email }, { username }] });
        if (existing) {
            return res.status(400).json({ message: 'Email or username already taken' });
        }

        const manager = new User({
            name,
            username,
            email,
            password,
            role: 'Manager',
            ownerId: req.user.userId   // Link manager to this Owner
        });

        await manager.save();

        // Assign manager to sites if provided
        if (siteIds && siteIds.length > 0) {
            await Site.updateMany(
                { _id: { $in: siteIds }, owner: req.user.userId },
                { $addToSet: { assignedManagers: manager._id } }
            );
        }

        res.status(201).json({
            message: 'Manager created successfully',
            manager: {
                id: manager._id,
                name: manager.name,
                username: manager.username,
                email: manager.email,
                role: manager.role
            }
        });
    } catch (error) {
        console.error('Create manager error:', error);
        res.status(500).json({ message: 'Server error: ' + error.message });
    }
});

// @route   GET /api/auth/managers
// @desc    Owner gets a list of all their managers
// @access  Private (Owner only)
router.get('/managers', auth, async (req, res) => {
    try {
        if (req.user.role !== 'Owner') {
            return res.status(403).json({ message: 'Access denied' });
        }

        const managers = await User.find({ role: 'Manager', ownerId: req.user.userId })
            .select('-password')
            .sort({ createdAt: -1 });

        // For each manager, find their assigned sites
        const managersWithSites = await Promise.all(managers.map(async (mgr) => {
            const sites = await Site.find({ assignedManagers: mgr._id, owner: req.user.userId })
                .select('name status');
            return { ...mgr.toObject(), assignedSites: sites };
        }));

        res.json(managersWithSites);
    } catch (error) {
        console.error('Get managers error:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

// @route   PUT /api/auth/managers/:id/sites
// @desc    Owner updates which sites a manager is assigned to
// @access  Private (Owner only)
router.put('/managers/:id/sites', auth, async (req, res) => {
    try {
        if (req.user.role !== 'Owner') {
            return res.status(403).json({ message: 'Access denied' });
        }

        const { siteIds } = req.body; // New list of site IDs for this manager

        const manager = await User.findOne({ _id: req.params.id, role: 'Manager', ownerId: req.user.userId });
        if (!manager) {
            return res.status(404).json({ message: 'Manager not found' });
        }

        // Remove this manager from ALL sites first, then re-assign
        await Site.updateMany(
            { owner: req.user.userId },
            { $pull: { assignedManagers: manager._id } }
        );

        if (siteIds && siteIds.length > 0) {
            await Site.updateMany(
                { _id: { $in: siteIds }, owner: req.user.userId },
                { $addToSet: { assignedManagers: manager._id } }
            );
        }

        res.json({ message: 'Manager site assignments updated' });
    } catch (error) {
        console.error('Update manager sites error:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

// @route   DELETE /api/auth/managers/:id
// @desc    Owner deletes a manager account
// @access  Private (Owner only)
router.delete('/managers/:id', auth, async (req, res) => {
    try {
        if (req.user.role !== 'Owner') {
            return res.status(403).json({ message: 'Access denied' });
        }

        const manager = await User.findOne({ _id: req.params.id, role: 'Manager', ownerId: req.user.userId });
        if (!manager) {
            return res.status(404).json({ message: 'Manager not found' });
        }

        // Remove from all site assignments
        await Site.updateMany(
            { owner: req.user.userId },
            { $pull: { assignedManagers: manager._id } }
        );

        await manager.deleteOne();
        res.json({ message: 'Manager deleted successfully' });
    } catch (error) {
        console.error('Delete manager error:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

// @route   POST /api/auth/forgot-password
// @desc    Initiate password reset, send verification code to email
// @access  Public
router.post('/forgot-password', async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) {
            return res.status(400).json({ message: 'Email is required' });
        }

        const user = await User.findOne({ email });
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        let targetEmail = user.email;

        // If manager, send to owner's email
        if (user.role === 'Manager') {
            if (!user.ownerId) {
                return res.status(400).json({ message: 'Manager has no owner assigned' });
            }
            const owner = await User.findById(user.ownerId);
            if (!owner) {
                return res.status(404).json({ message: 'Owner not found' });
            }
            targetEmail = owner.email;
        }

        // Generate a 6-digit verification code
        const code = Math.floor(100000 + Math.random() * 900000).toString();

        user.resetPasswordCode = code;
        user.resetPasswordExpires = Date.now() + 3600000; // 1 hour expiration
        await user.save();

        if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
            const mailOptions = {
                from: process.env.EMAIL_USER,
                to: targetEmail,
                subject: 'Password Reset Verification Code - KarmSaathi',
                text: `You have requested to reset your password. Here is your verification code: ${code}\n\nThis code will expire in 1 hour.`
            };

            await transporter.sendMail(mailOptions);
            res.json({ message: 'Verification code sent to email' });
        } else {
            console.log(`Email Service Not Configured. Verification code for ${user.email} (sent to ${targetEmail}) is ${code}`);
            res.json({ message: 'Verification code generated (check server console as EMAIL_USER is not set)' });
        }

    } catch (error) {
        console.error('Forgot password error:', error);
        res.status(500).json({ message: 'Server error: ' + error.message });
    }
});

// @route   POST /api/auth/reset-password
// @desc    Reset password using verification code
// @access  Public
router.post('/reset-password', async (req, res) => {
    try {
        const { email, code, newPassword } = req.body;
        if (!email || !code || !newPassword) {
            return res.status(400).json({ message: 'Email, code, and new password are required' });
        }

        const user = await User.findOne({ email });
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        if (user.resetPasswordCode !== code || !user.resetPasswordExpires || user.resetPasswordExpires < Date.now()) {
            return res.status(400).json({ message: 'Invalid or expired verification code' });
        }

        user.password = newPassword;
        user.resetPasswordCode = null;
        user.resetPasswordExpires = null;
        
        await user.save();

        res.json({ message: 'Password has been successfully reset' });

    } catch (error) {
        console.error('Reset password error:', error);
        res.status(500).json({ message: 'Server error: ' + error.message });
    }
});

module.exports = router;
