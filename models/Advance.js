const mongoose = require('mongoose');

const AdvanceSchema = new mongoose.Schema({
    labour: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Labour',
        required: true
    },
    site: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Site',
        required: true
    },
    amount: {
        type: Number,
        required: true,
        min: 1
    },
    reason: {
        type: String,
        trim: true,
        default: 'No reason provided'
    },
    dateGiven: {
        type: Date,
        required: true
    },
    status: {
        type: String,
        enum: ['Pending', 'Deducted'],
        default: 'Pending'
    },
    owner: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
});

module.exports = mongoose.model('Advance', AdvanceSchema);
