const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const Labour = require('../models/Labour');
const Site = require('../models/Site');
const Attendance = require('../models/Attendance');

// @route   GET /api/labours
// @desc    Get all labours for logged-in user
// @access  Private
router.get('/', auth, async (req, res) => {
    try {
        const labours = await Labour.find({ owner: req.user.userId })
            .populate('site', 'name')
            .sort({ createdAt: -1 });
        res.json(labours);
    } catch (err) {
        console.error('Fetch labours error:', err.message);
        res.status(500).send('Server Error');
    }
});

// @route   POST /api/labours
// @desc    Add a new labour
// @access  Private
router.post('/', auth, async (req, res) => {
    try {
        const { name, mobileNumber, address, site, aadharNumber, designation, dailyRate } = req.body;

        // Validate if site exists and belongs to user
        const siteObj = await Site.findById(site);
        if (!siteObj || siteObj.owner.toString() !== req.user.userId) {
            return res.status(400).json({ message: 'Invalid active site selected' });
        }

        const newLabour = new Labour({
            name,
            mobileNumber,
            address,
            site,
            aadharNumber,
            designation,
            dailyRate,
            owner: req.user.userId
        });

        const labour = await newLabour.save();

        // Also push this labour into the Site's assignedWorkers array
        siteObj.assignedWorkers.push(labour._id);
        await siteObj.save();

        // Return the newly created labour populated with site name
        const populatedLabour = await Labour.findById(labour._id).populate('site', 'name');
        res.json(populatedLabour);

    } catch (err) {
        console.error('Create labour error:', err.message);
        res.status(500).send('Server Error');
    }
});

// @route   GET /api/labours/:id
// @desc    Get single labourer by ID
// @access  Private
router.get('/:id', auth, async (req, res) => {
    try {
        const labour = await Labour.findById(req.params.id).populate('site', 'name');

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
        res.status(500).send('Server Error');
    }
});

// @route   PUT /api/labours/:id
// @desc    Update labourer details
// @access  Private
router.put('/:id', auth, async (req, res) => {
    try {
        const { name, mobileNumber, address, site, aadharNumber, designation, dailyRate } = req.body;

        let labour = await Labour.findById(req.params.id);

        if (!labour) {
            return res.status(404).json({ message: 'Worker not found' });
        }

        if (labour.owner.toString() !== req.user.userId) {
            return res.status(401).json({ message: 'User not authorized' });
        }

        // If site is changed, we need to handle the assignedWorkers array in Site model
        if (site && site !== labour.site.toString()) {
            const newSiteObj = await Site.findById(site);
            if (!newSiteObj || newSiteObj.owner.toString() !== req.user.userId) {
                return res.status(400).json({ message: 'Invalid active site selected' });
            }

            // Remove from old site ONLY if it is not Completed
            const oldSiteObj = await Site.findById(labour.site);
            if (oldSiteObj && oldSiteObj.status !== 'Completed') {
                await Site.findByIdAndUpdate(labour.site, { $pull: { assignedWorkers: labour._id } });
            }

            // Add to new site using $addToSet to avoid duplicates
            await Site.findByIdAndUpdate(site, { $addToSet: { assignedWorkers: labour._id } });
        }

        labour.name = name || labour.name;
        labour.mobileNumber = mobileNumber || labour.mobileNumber;
        labour.address = address || labour.address;
        labour.site = site || labour.site;
        labour.aadharNumber = aadharNumber || labour.aadharNumber;
        labour.designation = designation || labour.designation;
        labour.dailyRate = dailyRate !== undefined ? dailyRate : labour.dailyRate;

        await labour.save();

        const populatedLabour = await Labour.findById(labour._id).populate('site', 'name');
        res.json(populatedLabour);
    } catch (err) {
        console.error('Update labour error:', err.message);
        if (err.kind === 'ObjectId') {
            return res.status(404).json({ message: 'Worker not found' });
        }
        res.status(500).send('Server Error');
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

        // Clean up all related attendance records
        await Attendance.deleteMany({ labour: labour._id });

        // Ensure we use the proper delete method based on Mongoose version (deleteOne)
        await labour.deleteOne();

        res.json({ message: 'Worker deleted successfully' });
    } catch (err) {
        console.error('Delete labour error:', err.message);
        if (err.kind === 'ObjectId') {
            return res.status(404).json({ message: 'Worker not found' });
        }
        res.status(500).send('Server Error');
    }
});

module.exports = router;
