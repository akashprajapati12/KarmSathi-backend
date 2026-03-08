const mongoose = require('mongoose');

const SalarySchema = new mongoose.Schema({
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
    month: {
        type: Number,
        required: true // 1-12
    },
    year: {
        type: Number,
        required: true // e.g. 2024
    },
    presentDays: {
        type: Number,
        default: 0
    },
    basicSalary: {
        type: Number,
        default: 0
    },
    totalOvertimeHours: {
        type: Number,
        default: 0
    },
    overtimePay: {
        type: Number,
        default: 0
    },
    advanceTaken: {
        type: Number,
        default: 0
    },
    netPayable: {
        type: Number,
        default: 0
    },
    status: {
        type: String,
        enum: ['Pending', 'Paid'],
        default: 'Pending'
    },
    isArchivedFromGlobal: {
        type: Boolean,
        default: false
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

// Compound index to ensure a worker only has one salary record per site per month/year
SalarySchema.index({ labour: 1, site: 1, month: 1, year: 1 }, { unique: true });

module.exports = mongoose.model('Salary', SalarySchema);
