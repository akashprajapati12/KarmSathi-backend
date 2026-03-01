const mongoose = require('mongoose');

const siteSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        trim: true
    },
    address: {
        type: String,
        required: true,
        trim: true
    },
    owner: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    assignedWorkers: [{
        // Reference to the Labour collection IDs assigned to this site
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Labour'
    }],
    startDate: {
        type: Date,
        required: true,
        default: Date.now
    },
    endDate: {
        type: Date, // Present when a site is marked "Completed"
        default: null
    },
    status: {
        type: String,
        enum: ['Active', 'Completed'],
        default: 'Active'
    },
    photos: [{
        url: { type: String, required: true }, // Local path or cloud URL
        uploadedAt: { type: Date, default: Date.now },
        description: { type: String, default: '' }
    }],
    createdAt: {
        type: Date,
        default: Date.now
    }
});

module.exports = mongoose.model('Site', siteSchema);
