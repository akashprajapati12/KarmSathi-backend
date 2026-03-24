const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const Advance = require('../models/Advance');
const Labour = require('../models/Labour');
const Site = require('../models/Site');

// Helper: get the site IDs a Manager is assigned to
const getManagerSiteIds = async (managerId, ownerId) => {
    const sites = await Site.find({ owner: ownerId, assignedManagers: managerId }).select('_id');
    return sites.map(s => s._id);
};

// @route   POST /api/advances
// @desc    Record a new advance/loan for a worker
// @access  Private
router.post('/', auth, async (req, res) => {
    try {
        const ownerId = req.user.effectiveOwnerId;
        const { labourId, siteId, amount, reason, dateGiven } = req.body;

        if (!labourId || !siteId || !amount || !dateGiven) {
            return res.status(400).json({ message: 'Missing required fields' });
        }

        // Verify labour belongs to effective owner
        const labour = await Labour.findOne({ _id: labourId, owner: ownerId });
        if (!labour) return res.status(404).json({ message: 'Worker not found' });

        // Managers: verify the site is their assigned site
        if (req.user.role === 'Manager') {
            const assignedSiteIds = (await getManagerSiteIds(req.user.userId, ownerId)).map(id => id.toString());
            if (!assignedSiteIds.includes(siteId)) {
                return res.status(403).json({ message: 'You can only give advances for your assigned sites' });
            }
        }

        const advance = new Advance({
            labour: labourId,
            site: siteId,
            amount: Number(amount),
            reason,
            dateGiven,
            owner: ownerId   // Always stored under Owner's ID
        });

        await advance.save();
        res.json(advance);
    } catch (err) {
        console.error('Create advance error:', err.message);
        res.status(500).send('Server Error');
    }
});

// @route   GET /api/advances
// @desc    Get all advances — Managers only see their site's advances
// @access  Private
router.get('/', auth, async (req, res) => {
    try {
        const ownerId = req.user.effectiveOwnerId;
        const { labourId, status } = req.query;
        let query = { owner: ownerId };

        if (labourId) query.labour = labourId;
        if (status) query.status = status;

        // Managers: scope to their assigned sites
        if (req.user.role === 'Manager') {
            const assignedSiteIds = await getManagerSiteIds(req.user.userId, ownerId);
            query.site = { $in: assignedSiteIds };
        }

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
        const ownerId = req.user.effectiveOwnerId;
        const advance = await Advance.findOne({ _id: req.params.id, owner: ownerId });

        if (!advance) return res.status(404).json({ message: 'Advance record not found' });

        // Managers: verify site access
        if (req.user.role === 'Manager') {
            const assignedSiteIds = (await getManagerSiteIds(req.user.userId, ownerId)).map(id => id.toString());
            if (!assignedSiteIds.includes(advance.site.toString())) {
                return res.status(403).json({ message: 'Access denied' });
            }
        }

        await advance.deleteOne();
        res.json({ message: 'Advance removed' });
    } catch (err) {
        console.error('Delete advance error:', err.message);
        res.status(500).send('Server Error');
    }
});

module.exports = router;
