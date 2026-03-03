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
        cb(null, 'uploads/'); // Ensure this directory exists in /server
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

// Check File Type
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

// @route   GET /api/sites
// @desc    Get all active sites for logged-in user
// @access  Private
router.get('/', auth, async (req, res) => {
    try {
        const sites = await Site.find({ owner: req.user.userId, status: 'Active' }).sort({ createdAt: 1 });
        res.json(sites);
    } catch (err) {
        console.error('Fetch sites error:', err.message);
        res.status(500).send('Server Error');
    }
});

// @route   POST /api/sites
// @desc    Create a new site
// @access  Private
router.post('/', auth, async (req, res) => {
    try {
        const { name, address, startDate } = req.body;

        if (!name || !address || !startDate) {
            return res.status(400).json({ message: 'Please provide name, address, and startDate' });
        }

        const newSite = new Site({
            name,
            address,
            startDate,
            owner: req.user.userId
        });

        const site = await newSite.save();
        res.json(site);
    } catch (err) {
        console.error('Create site error:', err.message);
        res.status(500).send('Server Error');
    }
});

// @route   GET /api/sites/:id
// @desc    Get single site by ID
// @access  Private
router.get('/:id', auth, async (req, res) => {
    try {
        const site = await Site.findById(req.params.id);

        if (!site) {
            return res.status(404).json({ message: 'Site not found' });
        }

        // Ensure user owns the site
        if (site.owner.toString() !== req.user.userId) {
            return res.status(401).json({ message: 'User not authorized' });
        }

        res.json(site);
    } catch (err) {
        console.error('Get site error:', err.message);
        if (err.kind === 'ObjectId') {
            return res.status(404).json({ message: 'Site not found' });
        }
        res.status(500).send('Server Error');
    }
});

// @route   GET /api/sites/:id/workers
// @desc    Get all workers assigned to a specific site
// @access  Private
router.get('/:id/workers', auth, async (req, res) => {
    try {
        const site = await Site.findById(req.params.id).populate({
            path: 'assignedWorkers',
            match: { owner: req.user.userId },
            options: { sort: { name: 1 } }
        });
        if (!site) return res.status(404).json({ message: 'Site not found' });
        if (site.owner.toString() !== req.user.userId) return res.status(401).json({ message: 'User not authorized' });

        res.json(site.assignedWorkers);
    } catch (err) {
        console.error('Get site workers error:', err.message);
        res.status(500).send('Server Error');
    }
});

// @route   PUT /api/sites/:id/complete
// @desc    Mark a site as completed
// @access  Private
router.put('/:id/complete', auth, async (req, res) => {
    try {
        let site = await Site.findById(req.params.id);
        if (!site) return res.status(404).json({ message: 'Site not found' });
        if (site.owner.toString() !== req.user.userId) return res.status(401).json({ message: 'User not authorized' });

        site.status = 'Completed';
        site.endDate = Date.now();
        await site.save();
        res.json(site);
    } catch (err) {
        console.error('Complete site error:', err.message);
        res.status(500).send('Server Error');
    }
});

// @route   PUT /api/sites/:id
// @desc    Update a site (startDate, name, address)
// @access  Private
router.put('/:id', auth, async (req, res) => {
    try {
        let site = await Site.findById(req.params.id);
        if (!site) return res.status(404).json({ message: 'Site not found' });
        if (site.owner.toString() !== req.user.userId) return res.status(401).json({ message: 'User not authorized' });

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
// @desc    Delete a site
// @access  Private
router.delete('/:id', auth, async (req, res) => {
    try {
        const site = await Site.findById(req.params.id);
        if (!site) return res.status(404).json({ message: 'Site not found' });
        if (site.owner.toString() !== req.user.userId) return res.status(401).json({ message: 'User not authorized' });

        // Warning: This does not cascade delete workers. You may want to handle that in the UI.
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
        // Validate site ownership
        let site = await Site.findById(req.params.id);
        if (!site) return res.status(404).json({ message: 'Site not found' });
        if (site.owner.toString() !== req.user.userId) return res.status(401).json({ message: 'User not authorized' });

        if (!req.file) {
            return res.status(400).json({ message: 'No file uploaded' });
        }

        const photoObj = {
            url: `/uploads/${req.file.filename}`, // Assuming express.static is serving uploads
            description: req.body.description || ''
        };

        site.photos.unshift(photoObj); // Add newest photos to the beginning
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
