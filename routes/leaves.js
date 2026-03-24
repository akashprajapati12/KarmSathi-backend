const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const Leave = require('../models/Leave');
const Labour = require('../models/Labour');
const Attendance = require('../models/Attendance');
const Site = require('../models/Site');

// Helper: get the site IDs a Manager is assigned to
const getManagerSiteIds = async (managerId, ownerId) => {
    const sites = await Site.find({ owner: ownerId, assignedManagers: managerId }).select('_id');
    return sites.map(s => s._id);
};

// @route   POST /api/leaves
// @desc    Apply for a new leave
// @access  Private
router.post('/', auth, async (req, res) => {
    try {
        const ownerId = req.user.effectiveOwnerId;
        const { labourId, siteId, reason, startDate, endDate } = req.body;

        // Verify labour belongs to effective owner
        const labour = await Labour.findOne({ _id: labourId, owner: ownerId });
        if (!labour) return res.status(404).json({ message: 'Worker not found' });

        // Managers: verify site is their assigned site
        if (req.user.role === 'Manager') {
            const assignedSiteIds = (await getManagerSiteIds(req.user.userId, ownerId)).map(id => id.toString());
            if (!assignedSiteIds.includes(siteId)) {
                return res.status(403).json({ message: 'You can only apply leaves for your assigned sites' });
            }
        }

        const newLeave = new Leave({
            labour: labourId,
            site: siteId,
            reason,
            startDate,
            endDate,
            owner: ownerId   // Always stored under Owner's ID
        });

        const leave = await newLeave.save();
        res.json(leave);
    } catch (err) {
        console.error('Create leave error:', err.message);
        res.status(500).send('Server Error');
    }
});

// @route   GET /api/leaves
// @desc    Get all leaves — Managers see only their site's leaves
// @access  Private
router.get('/', auth, async (req, res) => {
    try {
        const ownerId = req.user.effectiveOwnerId;
        let query = { owner: ownerId };

        if (req.user.role === 'Manager') {
            const assignedSiteIds = await getManagerSiteIds(req.user.userId, ownerId);
            query.site = { $in: assignedSiteIds };
        }

        const leaves = await Leave.find(query)
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
        const ownerId = req.user.effectiveOwnerId;
        const leave = await Leave.findOne({ _id: req.params.id, owner: ownerId });

        if (!leave) return res.status(404).json({ message: 'Leave request not found' });

        // Managers: verify site access
        if (req.user.role === 'Manager') {
            const assignedSiteIds = (await getManagerSiteIds(req.user.userId, ownerId)).map(id => id.toString());
            if (!assignedSiteIds.includes(leave.site.toString())) {
                return res.status(403).json({ message: 'Access denied' });
            }
        }

        await leave.deleteOne();
        res.json({ message: 'Leave removed' });
    } catch (err) {
        console.error('Delete leave error:', err.message);
        res.status(500).send('Server Error');
    }
});

// @route   PUT /api/leaves/:id/status
// @desc    Approve or Deny a leave — Managers can approve for their sites
// @access  Private
router.put('/:id/status', auth, async (req, res) => {
    try {
        const ownerId = req.user.effectiveOwnerId;
        const { status } = req.body;

        if (!['Approved', 'Denied'].includes(status)) {
            return res.status(400).json({ message: 'Invalid status' });
        }

        const leave = await Leave.findOne({ _id: req.params.id, owner: ownerId });
        if (!leave) return res.status(404).json({ message: 'Leave request not found' });

        // Managers: verify site access
        if (req.user.role === 'Manager') {
            const assignedSiteIds = (await getManagerSiteIds(req.user.userId, ownerId)).map(id => id.toString());
            if (!assignedSiteIds.includes(leave.site.toString())) {
                return res.status(403).json({ message: 'Access denied' });
            }
        }

        // If approving, autofill 'Absent' attendance for the date range
        if (status === 'Approved' && leave.status !== 'Approved') {
            const start = new Date(leave.startDate);
            start.setUTCHours(0, 0, 0, 0);
            const end = new Date(leave.endDate);
            end.setUTCHours(0, 0, 0, 0);

            let loopDate = new Date(start);
            while (loopDate <= end) {
                await Attendance.findOneAndUpdate(
                    { labour: leave.labour, date: new Date(loopDate), owner: ownerId },
                    { status: 'Absent', hours: 0, site: leave.site },
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
