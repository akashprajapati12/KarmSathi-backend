const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const Site = require('../models/Site');
const Labour = require('../models/Labour');
const multer = require('multer');
const path = require('path');

// Configure Multer storage
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, 'uploads/');
    },
    filename: function (req, file, cb) {
        cb(null, req.params.id + '-' + Date.now() + path.extname(file.originalname));
    }
});

const upload = multer({
    storage: storage,
    limits: { fileSize: 5000000 }, // 5MB Limit
    fileFilter: function (req, file, cb) {
        checkFileType(file, cb);
    }
});

function checkFileType(file, cb) {
    const filetypes = /jpeg|jpg|png|gif/;
    const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = filetypes.test(file.mimetype);
    if (mimetype && extname) {
        return cb(null, true);
    } else {
        cb('Error: Images Only!');
    }
}

// Helper: get the site IDs a Manager is assigned to
const getManagerSiteIds = async (managerId, ownerId) => {
    const sites = await Site.find({ owner: ownerId, assignedManagers: managerId }).select('_id');
    return sites.map(s => s._id);
};

// @route   GET /api/sites
// @desc    Get sites — Owners see all their sites; Managers see only assigned sites
// @access  Private
router.get('/', auth, async (req, res) => {
    try {
        const ownerId = req.user.effectiveOwnerId;
        let query = { owner: ownerId };

        if (req.query.all !== 'true') {
            query.status = 'Active';
        }

        // Managers only see their assigned sites
        if (req.user.role === 'Manager') {
            const assignedSiteIds = await getManagerSiteIds(req.user.userId, ownerId);
            query._id = { $in: assignedSiteIds };
        }

        const sites = await Site.find(query).sort({ createdAt: 1 });
        res.json(sites);
    } catch (err) {
        console.error('Fetch sites error:', err.message);
        res.status(500).send('Server Error');
    }
});

// @route   POST /api/sites
// @desc    Create a new site (Owner only)
// @access  Private
router.post('/', auth, async (req, res) => {
    try {
        if (req.user.role === 'Manager') {
            return res.status(403).json({ message: 'Managers cannot create sites' });
        }

        const { name, address, startDate } = req.body;
        if (!name || !address || !startDate) {
            return res.status(400).json({ message: 'Please provide name, address, and startDate' });
        }

        const newSite = new Site({ name, address, startDate, owner: req.user.userId });
        const site = await newSite.save();
        res.json(site);
    } catch (err) {
        console.error('Create site error:', err.message);
        res.status(500).send('Server Error');
    }
});

// @route   GET /api/sites/:id
// @desc    Get single site — validates access for managers too
// @access  Private
router.get('/:id', auth, async (req, res) => {
    try {
        const ownerId = req.user.effectiveOwnerId;
        const site = await Site.findOne({ _id: req.params.id, owner: ownerId });

        if (!site) {
            return res.status(404).json({ message: 'Site not found' });
        }

        // Managers: verify this site is in their assigned list
        if (req.user.role === 'Manager') {
            const isAssigned = site.assignedManagers.some(m => m.toString() === req.user.userId);
            if (!isAssigned) return res.status(403).json({ message: 'Access denied to this site' });
        }

        res.json(site);
    } catch (err) {
        console.error('Get site error:', err.message);
        if (err.kind === 'ObjectId') return res.status(404).json({ message: 'Site not found' });
        res.status(500).send('Server Error');
    }
});

// @route   GET /api/sites/:id/workers
// @desc    Get workers at a specific site
// @access  Private
router.get('/:id/workers', auth, async (req, res) => {
    try {
        const ownerId = req.user.effectiveOwnerId;
        const site = await Site.findOne({ _id: req.params.id, owner: ownerId }).populate({
            path: 'assignedWorkers',
            match: { owner: ownerId },
            options: { sort: { name: 1 } }
        });

        if (!site) return res.status(404).json({ message: 'Site not found' });

        // Managers: verify site access
        if (req.user.role === 'Manager') {
            const isAssigned = site.assignedManagers.some(m => m.toString() === req.user.userId);
            if (!isAssigned) return res.status(403).json({ message: 'Access denied to this site' });
        }

        res.json(site.assignedWorkers);
    } catch (err) {
        console.error('Get site workers error:', err.message);
        res.status(500).send('Server Error');
    }
});

// @route   PUT /api/sites/:id/complete
// @desc    Mark a site as completed (Owner only)
// @access  Private
router.put('/:id/complete', auth, async (req, res) => {
    try {
        if (req.user.role === 'Manager') {
            return res.status(403).json({ message: 'Managers cannot complete sites' });
        }

        let site = await Site.findOne({ _id: req.params.id, owner: req.user.userId });
        if (!site) return res.status(404).json({ message: 'Site not found' });

        site.status = 'Completed';
        site.endDate = Date.now();
        await site.save();

        await Labour.updateMany(
            { sites: req.params.id },
            { $pull: { sites: req.params.id } }
        );

        res.json(site);
    } catch (err) {
        console.error('Complete site error:', err.message);
        res.status(500).send('Server Error');
    }
});

// @route   PUT /api/sites/:id
// @desc    Update a site (Owner only)
// @access  Private
router.put('/:id', auth, async (req, res) => {
    try {
        if (req.user.role === 'Manager') {
            return res.status(403).json({ message: 'Managers cannot edit site details' });
        }

        let site = await Site.findOne({ _id: req.params.id, owner: req.user.userId });
        if (!site) return res.status(404).json({ message: 'Site not found' });

        const { name, address, startDate } = req.body;
        if (name) site.name = name;
        if (address) site.address = address;
        if (startDate) site.startDate = startDate;

        await site.save();
        res.json(site);
    } catch (err) {
        console.error('Update site error:', err.message);
        res.status(500).send('Server Error');
    }
});

// @route   DELETE /api/sites/:id
// @desc    Delete a site (Owner only)
// @access  Private
router.delete('/:id', auth, async (req, res) => {
    try {
        if (req.user.role === 'Manager') {
            return res.status(403).json({ message: 'Managers cannot delete sites' });
        }

        const site = await Site.findOne({ _id: req.params.id, owner: req.user.userId });
        if (!site) return res.status(404).json({ message: 'Site not found' });

        await Site.findByIdAndDelete(req.params.id);
        res.json({ message: 'Site removed' });
    } catch (err) {
        console.error('Delete site error:', err.message);
        res.status(500).send('Server Error');
    }
});

// @route   POST /api/sites/:id/upload
// @desc    Upload a photo for a site
// @access  Private
router.post('/:id/upload', auth, upload.single('photo'), async (req, res) => {
    try {
        const ownerId = req.user.effectiveOwnerId;
        let site = await Site.findOne({ _id: req.params.id, owner: ownerId });
        if (!site) return res.status(404).json({ message: 'Site not found' });

        if (req.user.role === 'Manager') {
            const isAssigned = site.assignedManagers.some(m => m.toString() === req.user.userId);
            if (!isAssigned) return res.status(403).json({ message: 'Access denied to this site' });
        }

        if (!req.file) {
            return res.status(400).json({ message: 'No file uploaded' });
        }

        const photoObj = {
            url: `/uploads/${req.file.filename}`,
            description: req.body.description || ''
        };

        site.photos.unshift(photoObj);
        await site.save();
        res.json(site);
    } catch (err) {
        console.error('Upload photo error:', err.message);
        if (err.message === 'Error: Images Only!') {
            return res.status(400).json({ message: err.message });
        }
        res.status(500).send('Server Error');
    }
});

module.exports = router;
