const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const Advance = require('../models/Advance');
const Labour = require('../models/Labour');

// @route   POST /api/advances
// @desc    Record a new advance/loan for a worker
// @access  Private
router.post('/', auth, async (req, res) => {
    try {
        const { labourId, siteId, amount, reason, dateGiven } = req.body;

        if (!labourId || !siteId || !amount || !dateGiven) {
            return res.status(400).json({ message: 'Missing required fields' });
        }

        // Verify labour belongs to user
        const labour = await Labour.findById(labourId);
        if (!labour || labour.owner.toString() !== req.user.userId) {
            return res.status(404).json({ message: 'Worker not found' });
        }

        const advance = new Advance({
            labour: labourId,
            site: siteId,
            amount: Number(amount),
            reason,
            dateGiven,
            owner: req.user.userId
        });

        await advance.save();
        res.json(advance);

    } catch (err) {
        console.error('Create advance error:', err.message);
        res.status(500).send('Server Error');
    }
});

// @route   GET /api/advances
// @desc    Get all advances, optionally filter by worker or status
// @access  Private
router.get('/', auth, async (req, res) => {
    try {
        const { labourId, status } = req.query;
        let query = { owner: req.user.userId };

        if (labourId) query.labour = labourId;
        if (status) query.status = status;

        const advances = await Advance.find(query)
            .populate('labour', 'name designation mobileNumber')
            .populate('site', 'name')
            .sort({ dateGiven: -1 });

        res.json(advances);
    } catch (err) {
        console.error('Fetch advances error:', err.message);
        res.status(500).send('Server Error');
    }
});

// @route   DELETE /api/advances/:id
// @desc    Delete an advance record
// @access  Private
router.delete('/:id', auth, async (req, res) => {
    try {
        const advance = await Advance.findById(req.params.id);

        if (!advance) return res.status(404).json({ message: 'Advance record not found' });
        if (advance.owner.toString() !== req.user.userId) return res.status(401).json({ message: 'Not authorized' });

        await advance.deleteOne();
        res.json({ message: 'Advance removed' });
    } catch (err) {
        console.error('Delete advance error:', err.message);
        res.status(500).send('Server Error');
    }
});

module.exports = router;
