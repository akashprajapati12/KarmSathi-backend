const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const Labour = require('../models/Labour');
const Site = require('../models/Site');
const Attendance = require('../models/Attendance');
const Advance = require('../models/Advance');
const Salary = require('../models/Salary');

// @route   GET /api/labours
// @desc    Get all labours for logged-in user
// @access  Private
router.get('/', auth, async (req, res) => {
    try {
        const labours = await Labour.find({ owner: req.user.userId })
            .populate('sites', 'name')
            .sort({ createdAt: -1 });
        res.json(labours);
    } catch (err) {
        console.error('Fetch labours error:', err.message);
        res.status(500).json({ message: err.message || 'Server Error' });
    }
});

// @route   POST /api/labours
// @desc    Add a new labour
// @access  Private
router.post('/', auth, async (req, res) => {
    try {
        const { name, mobileNumber, address, sites, aadharNumber, designation, dailyRate } = req.body;

        // If 'site' (singular) is provided for backward compatibility, convert to array
        const siteList = Array.isArray(sites) ? sites : (req.body.site ? [req.body.site] : []);

        if (siteList.length === 0) {
            return res.status(400).json({ message: 'At least one site must be selected' });
        }

        // Validate if all sites exist and belong to user
        const siteObjs = await Site.find({ _id: { $in: siteList }, owner: req.user.userId });
        if (siteObjs.length !== siteList.length) {
            return res.status(400).json({ message: 'One or more invalid sites selected' });
        }

        const newLabour = new Labour({
            name,
            mobileNumber,
            address,
            sites: siteList,
            aadharNumber,
            designation,
            dailyRate,
            owner: req.user.userId
        });

        const labour = await newLabour.save();

        // Also push this labour into all selected Sites' assignedWorkers array
        await Site.updateMany(
            { _id: { $in: siteList } },
            { $addToSet: { assignedWorkers: labour._id } }
        );

        // Return the newly created labour populated with sites name
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
        const labour = await Labour.findById(req.params.id).populate('sites', 'name');

        if (!labour) {
            return res.status(404).json({ message: 'Worker not found' });
        }

        if (labour.owner.toString() !== req.user.userId) {
            return res.status(401).json({ message: 'User not authorized' });
        }

        res.json(labour);
    } catch (err) {
        console.error('Get labour error:', err.message);
        if (err.kind === 'ObjectId') {
            return res.status(404).json({ message: 'Worker not found' });
        }
        res.status(500).json({ message: err.message || 'Server Error' });
    }
});

// @route   PUT /api/labours/:id
// @desc    Update labourer details
// @access  Private
router.put('/:id', auth, async (req, res) => {
    try {
        const { name, mobileNumber, address, sites, aadharNumber, designation, dailyRate } = req.body;

        let labour = await Labour.findById(req.params.id);

        if (!labour) {
            return res.status(404).json({ message: 'Worker not found' });
        }

        if (labour.owner.toString() !== req.user.userId) {
            return res.status(401).json({ message: 'User not authorized' });
        }

        // Handle multiple sites updates
        const newSiteList = Array.isArray(sites) ? sites : (req.body.site ? [req.body.site] : null);

        if (newSiteList !== null) {
            // Validate new sites
            const siteObjs = await Site.find({ _id: { $in: newSiteList }, owner: req.user.userId });
            if (siteObjs.length !== newSiteList.length) {
                return res.status(400).json({ message: 'One or more invalid sites selected' });
            }

            const oldSiteList = (labour.sites || []).map(s => s.toString());

            // Sites to remove from: in old but not in new
            const toRemove = oldSiteList.filter(s => !newSiteList.includes(s));
            // Sites to add to: in new but not in old
            const toAdd = newSiteList.filter(s => !oldSiteList.includes(s));

            if (toRemove.length > 0) {
                await Site.updateMany(
                    { _id: { $in: toRemove } },
                    { $pull: { assignedWorkers: labour._id } }
                );
            }

            if (toAdd.length > 0) {
                await Site.updateMany(
                    { _id: { $in: toAdd } },
                    { $addToSet: { assignedWorkers: labour._id } }
                );
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
        if (err.kind === 'ObjectId') {
            return res.status(404).json({ message: 'Worker not found' });
        }
        res.status(500).json({ message: err.message || 'Server Error' });
    }
});

// @route   GET /api/labours/:id/site-summary
// @desc    Get site-wise work summary for a specific labourer
// @access  Private
router.get('/:id/site-summary', auth, async (req, res) => {
    try {
        const labourId = req.params.id;

        // Verify labour belongs to user
        const labour = await Labour.findById(labourId);
        if (!labour || labour.owner.toString() !== req.user.userId) {
            return res.status(404).json({ message: 'Worker not found' });
        }

        // Aggregate attendance records by site for 'Present', 'Half Day', or 'Overtime'
        const summary = await Attendance.aggregate([
            {
                $match: {
                    labour: labour._id,
                    status: { $in: ['Present', 'Half Day', 'Overtime'] }
                }
            },
            {
                $group: {
                    _id: '$site',
                    presentCount: {
                        $sum: { $cond: [{ $eq: ['$status', 'Half Day'] }, 0.5, 1] }
                    }
                }
            },
            {
                $lookup: {
                    from: 'sites',
                    localField: '_id',
                    foreignField: '_id',
                    as: 'siteInfo'
                }
            },
            { $unwind: '$siteInfo' },
            { $match: { 'siteInfo.status': { $ne: 'Completed' } } },
            {
                $project: {
                    siteId: { $toString: '$_id' },
                    siteName: '$siteInfo.name',
                    count: '$presentCount'
                }
            }
        ]);

        res.json(summary);
    } catch (err) {
        console.error('Fetch site summary error:', err.message);
        res.status(500).json({ message: err.message || 'Server Error' });
    }
});

// @route   DELETE /api/labours/:id
// @desc    Delete a labourer
// @access  Private
router.delete('/:id', auth, async (req, res) => {
    try {
        const labour = await Labour.findById(req.params.id);

        if (!labour) {
            return res.status(404).json({ message: 'Worker not found' });
        }

        if (labour.owner.toString() !== req.user.userId) {
            return res.status(401).json({ message: 'User not authorized' });
        }

        // Remove labour from ALL associated Sites' assignedWorkers array
        await Site.updateMany(
            { assignedWorkers: labour._id },
            { $pull: { assignedWorkers: labour._id } }
        );

        // Clean up all related attendance, advance, and salary records
        await Attendance.deleteMany({ labour: labour._id });
        await Advance.deleteMany({ labour: labour._id });
        await Salary.deleteMany({ labour: labour._id });

        // Ensure we use the proper delete method based on Mongoose version (deleteOne)
        await labour.deleteOne();

        res.json({ message: 'Worker deleted successfully' });
    } catch (err) {
        console.error('Delete labour error:', err.message);
        if (err.kind === 'ObjectId') {
            return res.status(404).json({ message: 'Worker not found' });
        }
        res.status(500).json({ message: err.message || 'Server Error' });
    }
});

module.exports = router;
