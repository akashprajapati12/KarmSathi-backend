const mongoose = require('mongoose');

const attendanceSchema = new mongoose.Schema({
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
    owner: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    date: {
        type: Date,
        required: true
    },
    status: {
        type: String,
        enum: ['Present', 'Absent', 'Half Day', 'Overtime'],
        required: true
    },
    hours: {
        type: Number,
        default: 0
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
});

// Ensure a labourer can only have one attendance record per day
attendanceSchema.index({ labour: 1, date: 1 }, { unique: true });

// Optimize query for dashboard today's attendance (owner + date)
attendanceSchema.index({ owner: 1, date: 1 });

module.exports = mongoose.model('Attendance', attendanceSchema);
