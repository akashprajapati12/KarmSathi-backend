const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const User = require('../models/User');
const Labour = require('../models/Labour');
const Site = require('../models/Site');
const Attendance = require('../models/Attendance');
const Leave = require('../models/Leave');
const Salary = require('../models/Salary');
const Advance = require('../models/Advance');

// @route   GET /api/user/dashboard
// @desc    Get logged in user dashboard data
// @access  Private
router.get('/dashboard', auth, async (req, res) => {
    try {
        // Only fetch data for the authenticated user, excluding password
        const user = await User.findById(req.user.userId).select('-password');
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        // Calculate start and end of today
        const startOfDay = new Date();
        startOfDay.setHours(0, 0, 0, 0);

        const endOfDay = new Date();
        endOfDay.setHours(23, 59, 59, 999);

        const [totalWorkers, totalSites, presentCount, absentCount] = await Promise.all([
            Labour.countDocuments({ owner: req.user.userId }),
            Site.countDocuments({ owner: req.user.userId, status: 'Active' }),
            Attendance.countDocuments({
                owner: req.user.userId,
                date: { $gte: startOfDay, $lte: endOfDay },
                status: { $in: ['Present', 'Half Day', 'Overtime'] }
            }),
            Attendance.countDocuments({
                owner: req.user.userId,
                date: { $gte: startOfDay, $lte: endOfDay },
                status: 'Absent'
            })
        ]);

        res.json({
            message: 'Welcome to your private dashboard',
            user: {
                id: user._id,
                name: user.name,
                username: user.username,
                email: user.email,
                createdAt: user.createdAt
            },
            stats: {
                totalWorkers,
                totalSites,
                attendanceToday: {
                    present: presentCount,
                    absent: absentCount
                }
            }
        });
    } catch (err) {
        console.error('Dashboard error:', err.message);
        res.status(500).send('Server Error');
    }
});

// @route   PUT /api/user/account
// @desc    Update user account details
// @access  Private
router.put('/account', auth, async (req, res) => {
    try {
        const { name, username, email, password } = req.body;
        const user = await User.findById(req.user.userId);

        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        if (name && name !== user.name) {
            user.name = name;
        }

        if (email && email !== user.email) {
            const existingUser = await User.findOne({ email });
            if (existingUser) return res.status(400).json({ message: 'Email already in use' });
            user.email = email;
        }

        if (username && username !== user.username) {
            const existingUser = await User.findOne({ username });
            if (existingUser) return res.status(400).json({ message: 'Username already in use' });
            user.username = username;
        }

        if (password && password.length > 5) {
            user.password = password; // pre-save hook will hash it
        }

        await user.save();

        res.json({
            message: 'User updated successfully',
            user: {
                id: user._id,
                name: user.name,
                username: user.username,
                email: user.email,
                createdAt: user.createdAt
            }
        });
    } catch (err) {
        console.error('Update acc error:', err.message);
        res.status(500).json({ message: 'Server error during update' });
    }
});

// @route   DELETE /api/user/account
// @desc    Delete user account and all references
// @access  Private
router.delete('/account', auth, async (req, res) => {
    try {
        const userId = req.user.userId;

        // Cascade delete all data across collections tied to user
        await Labour.deleteMany({ owner: userId });
        await Site.deleteMany({ owner: userId });
        await Attendance.deleteMany({ owner: userId });
        await Leave.deleteMany({ owner: userId });
        await Salary.deleteMany({ owner: userId });
        await Advance.deleteMany({ owner: userId });

        // Delete user object itself
        await User.findByIdAndDelete(userId);

        res.json({ message: 'Successfully deleted account and all associated records' });
    } catch (err) {
        console.error('Delete acc error:', err.message);
        res.status(500).json({ message: 'Server error during deletion' });
    }
});

module.exports = router;
