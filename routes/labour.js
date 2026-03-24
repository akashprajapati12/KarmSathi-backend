const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const Labour = require('../models/Labour');
const Site = require('../models/Site');
const Attendance = require('../models/Attendance');
const Advance = require('../models/Advance');
const Salary = require('../models/Salary');

// Helper: get the site IDs a Manager is assigned to
const getManagerSiteIds = async (managerId, ownerId) => {
    const sites = await Site.find({ owner: ownerId, assignedManagers: managerId }).select('_id');
    return sites.map(s => s._id);
};

// @route   GET /api/labours
// @desc    Get all labours — Managers only see workers at their sites
// @access  Private
router.get('/', auth, async (req, res) => {
    try {
        const ownerId = req.user.effectiveOwnerId;
        let query = { owner: ownerId };

        if (req.user.role === 'Manager') {
            const assignedSiteIds = await getManagerSiteIds(req.user.userId, ownerId);
            query.sites = { $in: assignedSiteIds };
        }

        const labours = await Labour.find(query)
            .populate('sites', 'name')
            .sort({ createdAt: -1 });
        res.json(labours);
    } catch (err) {
        console.error('Fetch labours error:', err.message);
        res.status(500).json({ message: err.message || 'Server Error' });
    }
});

// @route   POST /api/labours
// @desc    Add a new labour — Managers can only add to their assigned sites
// @access  Private
router.post('/', auth, async (req, res) => {
    try {
        const ownerId = req.user.effectiveOwnerId;
        const { name, mobileNumber, address, sites, aadharNumber, designation, dailyRate } = req.body;

        const siteList = Array.isArray(sites) ? sites : (req.body.site ? [req.body.site] : []);

        if (siteList.length === 0) {
            return res.status(400).json({ message: 'At least one site must be selected' });
        }

        // Validate sites belong to effective owner
        const siteObjs = await Site.find({ _id: { $in: siteList }, owner: ownerId });
        if (siteObjs.length !== siteList.length) {
            return res.status(400).json({ message: 'One or more invalid sites selected' });
        }

        // Managers: ensure they are only adding to their assigned sites
        if (req.user.role === 'Manager') {
            const assignedSiteIds = await getManagerSiteIds(req.user.userId, ownerId);
            const assignedStrings = assignedSiteIds.map(id => id.toString());
            const unauthorized = siteList.filter(s => !assignedStrings.includes(s));
            if (unauthorized.length > 0) {
                return res.status(403).json({ message: 'You can only add workers to your assigned sites' });
            }
        }

        const newLabour = new Labour({
            name, mobileNumber, address,
            sites: siteList,
            aadharNumber, designation, dailyRate,
            owner: ownerId   // Always stored under the Owner's ID
        });

        const labour = await newLabour.save();

        await Site.updateMany(
            { _id: { $in: siteList } },
            { $addToSet: { assignedWorkers: labour._id } }
        );

        const populatedLabour = await Labour.findById(labour._id).populate('sites', 'name');
        res.json(populatedLabour);
    } catch (err) {
        console.error('Create labour error:', err.message);
        res.status(500).json({ message: err.message || 'Server Error' });
    }
});

// @route   GET /api/labours/:id
// @desc    Get single labourer by ID
// @access  Private
router.get('/:id', auth, async (req, res) => {
    try {
        const ownerId = req.user.effectiveOwnerId;
        const labour = await Labour.findOne({ _id: req.params.id, owner: ownerId }).populate('sites', 'name');

        if (!labour) {
            return res.status(404).json({ message: 'Worker not found' });
        }

        // Managers: verify worker belongs to their site
        if (req.user.role === 'Manager') {
            const assignedSiteIds = (await getManagerSiteIds(req.user.userId, ownerId)).map(id => id.toString());
            const workerSiteIds = labour.sites.map(s => s._id.toString());
            const hasAccess = workerSiteIds.some(s => assignedSiteIds.includes(s));
            if (!hasAccess) return res.status(403).json({ message: 'Access denied to this worker' });
        }

        res.json(labour);
    } catch (err) {
        console.error('Get labour error:', err.message);
        if (err.kind === 'ObjectId') return res.status(404).json({ message: 'Worker not found' });
        res.status(500).json({ message: err.message || 'Server Error' });
    }
});

// @route   PUT /api/labours/:id
// @desc    Update labourer details
// @access  Private
router.put('/:id', auth, async (req, res) => {
    try {
        const ownerId = req.user.effectiveOwnerId;
        const { name, mobileNumber, address, sites, aadharNumber, designation, dailyRate } = req.body;

        let labour = await Labour.findOne({ _id: req.params.id, owner: ownerId });
        if (!labour) return res.status(404).json({ message: 'Worker not found' });

        const newSiteList = Array.isArray(sites) ? sites : (req.body.site ? [req.body.site] : null);

        if (newSiteList !== null) {
            const siteObjs = await Site.find({ _id: { $in: newSiteList }, owner: ownerId });
            if (siteObjs.length !== newSiteList.length) {
                return res.status(400).json({ message: 'One or more invalid sites selected' });
            }

            // Managers: can only assign within their sites
            if (req.user.role === 'Manager') {
                const assignedSiteIds = (await getManagerSiteIds(req.user.userId, ownerId)).map(id => id.toString());
                const unauthorized = newSiteList.filter(s => !assignedSiteIds.includes(s));
                if (unauthorized.length > 0) {
                    return res.status(403).json({ message: 'You can only assign workers to your sites' });
                }
            }

            const oldSiteList = (labour.sites || []).map(s => s.toString());
            const toRemove = oldSiteList.filter(s => !newSiteList.includes(s));
            const toAdd = newSiteList.filter(s => !oldSiteList.includes(s));

            if (toRemove.length > 0) {
                await Site.updateMany({ _id: { $in: toRemove } }, { $pull: { assignedWorkers: labour._id } });
            }
            if (toAdd.length > 0) {
                await Site.updateMany({ _id: { $in: toAdd } }, { $addToSet: { assignedWorkers: labour._id } });
            }

            labour.sites = newSiteList;
        }

        labour.name = name || labour.name;
        labour.mobileNumber = mobileNumber || labour.mobileNumber;
        labour.address = address || labour.address;
        labour.aadharNumber = aadharNumber || labour.aadharNumber;
        labour.designation = designation || labour.designation;
        if (dailyRate !== undefined && dailyRate !== null && dailyRate !== '') {
            labour.dailyRate = Number(dailyRate);
        }

        await labour.save();
        const populatedLabour = await Labour.findById(labour._id).populate('sites', 'name');
        res.json(populatedLabour);
    } catch (err) {
        console.error('Update labour error:', err.stack || err.message);
        if (err.kind === 'ObjectId') return res.status(404).json({ message: 'Worker not found' });
        res.status(500).json({ message: err.message || 'Server Error' });
    }
});

// @route   GET /api/labours/:id/site-summary
// @desc    Get site-wise work summary for a specific labourer
// @access  Private
router.get('/:id/site-summary', auth, async (req, res) => {
    try {
        const ownerId = req.user.effectiveOwnerId;
        const labour = await Labour.findOne({ _id: req.params.id, owner: ownerId });
        if (!labour) return res.status(404).json({ message: 'Worker not found' });

        const summary = await Attendance.aggregate([
            { $match: { labour: labour._id, status: { $in: ['Present', 'Half Day', 'Overtime'] } } },
            { $group: { _id: '$site', presentCount: { $sum: { $cond: [{ $eq: ['$status', 'Half Day'] }, 0.5, 1] } } } },
            { $lookup: { from: 'sites', localField: '_id', foreignField: '_id', as: 'siteInfo' } },
            { $unwind: '$siteInfo' },
            { $match: { 'siteInfo.status': { $ne: 'Completed' } } },
            { $project: { siteId: { $toString: '$_id' }, siteName: '$siteInfo.name', count: '$presentCount' } }
        ]);

        res.json(summary);
    } catch (err) {
        console.error('Fetch site summary error:', err.message);
        res.status(500).json({ message: err.message || 'Server Error' });
    }
});

// @route   DELETE /api/labours/:id
// @desc    Delete a labourer (Owner only)
// @access  Private
router.delete('/:id', auth, async (req, res) => {
    try {
        if (req.user.role === 'Manager') {
            return res.status(403).json({ message: 'Managers cannot delete workers' });
        }

        const labour = await Labour.findOne({ _id: req.params.id, owner: req.user.userId });
        if (!labour) return res.status(404).json({ message: 'Worker not found' });

        await Site.updateMany({ assignedWorkers: labour._id }, { $pull: { assignedWorkers: labour._id } });
        await Attendance.deleteMany({ labour: labour._id });
        await Advance.deleteMany({ labour: labour._id });
        await Salary.deleteMany({ labour: labour._id });
        await labour.deleteOne();

        res.json({ message: 'Worker deleted successfully' });
    } catch (err) {
        console.error('Delete labour error:', err.message);
        if (err.kind === 'ObjectId') return res.status(404).json({ message: 'Worker not found' });
        res.status(500).json({ message: err.message || 'Server Error' });
    }
});

module.exports = router;
