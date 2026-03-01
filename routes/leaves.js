const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const Leave = require('../models/Leave');
const Labour = require('../models/Labour');
const Attendance = require('../models/Attendance');

// @route   POST /api/leaves
// @desc    Apply for a new leave
// @access  Private
router.post('/', auth, async (req, res) => {
    try {
        const { labourId, siteId, reason, startDate, endDate } = req.body;

        // Verify labour belongs to user
        const labour = await Labour.findById(labourId);
        if (!labour || labour.owner.toString() !== req.user.userId) {
            return res.status(404).json({ message: 'Worker not found' });
        }

        const newLeave = new Leave({
            labour: labourId,
            site: siteId,
            reason,
            startDate,
            endDate,
            owner: req.user.userId
        });

        const leave = await newLeave.save();
        res.json(leave);

    } catch (err) {
        console.error('Create leave error:', err.message);
        res.status(500).send('Server Error');
    }
});

// @route   GET /api/leaves
// @desc    Get all leaves for the user
// @access  Private
router.get('/', auth, async (req, res) => {
    try {
        const leaves = await Leave.find({ owner: req.user.userId })
            .populate('labour', 'name designation')
            .populate('site', 'name')
            .sort({ createdAt: -1 });
        res.json(leaves);
    } catch (err) {
        console.error('Fetch leaves error:', err.message);
        res.status(500).send('Server Error');
    }
});

// @route   DELETE /api/leaves/:id
// @desc    Delete a leave request
// @access  Private
router.delete('/:id', auth, async (req, res) => {
    try {
        const leave = await Leave.findById(req.params.id);

        if (!leave) return res.status(404).json({ message: 'Leave request not found' });
        if (leave.owner.toString() !== req.user.userId) return res.status(401).json({ message: 'Not authorized' });

        await leave.deleteOne();
        res.json({ message: 'Leave removed' });
    } catch (err) {
        console.error('Delete leave error:', err.message);
        res.status(500).send('Server Error');
    }
});

// @route   PUT /api/leaves/:id/status
// @desc    Approve or Deny a leave
// @access  Private
router.put('/:id/status', auth, async (req, res) => {
    try {
        const { status } = req.body; // 'Approved' or 'Denied'

        if (!['Approved', 'Denied'].includes(status)) {
            return res.status(400).json({ message: 'Invalid status' });
        }

        const leave = await Leave.findById(req.params.id);

        if (!leave) return res.status(404).json({ message: 'Leave request not found' });
        if (leave.owner.toString() !== req.user.userId) return res.status(401).json({ message: 'Not authorized' });

        // If approving, autofill 'Absent' attendance for the date range
        if (status === 'Approved' && leave.status !== 'Approved') {
            const start = new Date(leave.startDate);
            start.setUTCHours(0, 0, 0, 0);
            const end = new Date(leave.endDate);
            end.setUTCHours(0, 0, 0, 0);

            let loopDate = new Date(start);
            while (loopDate <= end) {
                // Upsert absent record
                await Attendance.findOneAndUpdate(
                    {
                        labour: leave.labour,
                        date: new Date(loopDate),
                        owner: req.user.userId
                    },
                    {
                        status: 'Absent',
                        hours: 0,
                        site: leave.site
                    },
                    { new: true, upsert: true }
                );
                loopDate.setDate(loopDate.getDate() + 1);
            }
        }

        leave.status = status;
        await leave.save();
        res.json(leave);

    } catch (err) {
        console.error('Update leave status error:', err.message);
        res.status(500).send('Server Error');
    }
});


module.exports = router;
