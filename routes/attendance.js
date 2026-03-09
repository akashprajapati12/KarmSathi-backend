const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const Attendance = require('../models/Attendance');
const Labour = require('../models/Labour');
const Leave = require('../models/Leave');
const mongoose = require('mongoose');

// @route   GET /api/attendance/summary/:labourId/:year/:month
// @desc    Get monthly calendar attendance summary for a specific labourer
// @access  Private
router.get('/summary/:labourId/:year/:month', auth, async (req, res) => {
    try {
        const { labourId, year, month } = req.params;

        // Verify labour belongs to user
        const labour = await Labour.findById(labourId);
        if (!labour || labour.owner.toString() !== req.user.userId) {
            return res.status(404).json({ message: 'Worker not found' });
        }

        // Construct start and end dates for the month
        // Note: Month from client is 1-indexed (1=Jan, 12=Dec)
        const startDate = new Date(year, month - 1, 1);
        const endDate = new Date(year, month, 0, 23, 59, 59); // Last day of month

        const attendanceRecords = await Attendance.find({
            labour: labourId,
            owner: req.user.userId,
            date: {
                $gte: startDate,
                $lte: endDate
            }
        }).populate('site', 'name');

        // Format for easier frontend calendar parsing
        // Response map format: { "YYYY-MM-DD": { status, siteName } }
        const calendarMap = {};
        const stats = {
            present: 0,
            absent: 0,
            halfDay: 0,
            overtime: 0,
            overtimeHours: 0
        };

        attendanceRecords.forEach(record => {
            // Normalize date to YYYY-MM-DD local format safely
            const dateString = record.date.toISOString().split('T')[0];
            calendarMap[dateString] = {
                status: record.status,
                siteName: record.site?.name || 'Unknown Site',
                siteId: record.site?._id ? record.site._id.toString() : null
            };

            if (record.status === 'Present') stats.present++;
            else if (record.status === 'Absent') stats.absent++;
            else if (record.status === 'Half Day') stats.halfDay++;
            else if (record.status === 'Overtime') {
                stats.overtime++;
                if (record.hours > 8) {
                    stats.overtimeHours += (record.hours - 8); // Extra OT hours
                }
            }
        });

        res.json({
            records: calendarMap,
            stats: stats
        });

    } catch (err) {
        console.error('Fetch attendance error:', err.message);
        res.status(500).send('Server Error');
    }
});

// @route   GET /api/attendance/daily/:date
// @desc    Get all attendance records for a specific date
// @access  Private
router.get('/daily/:date', auth, async (req, res) => {
    try {
        const { date } = req.params;

        // Normalize date
        const targetDate = new Date(date);
        targetDate.setUTCHours(0, 0, 0, 0);

        // Fetch all records for this user on this day
        const records = await Attendance.find({
            owner: req.user.userId,
            date: targetDate
        }).populate('labour', 'name designation dailyRate'); // Populate labour details

        // Fetch any Approved leaves that cover this date
        const activeLeaves = await Leave.find({
            owner: req.user.userId,
            status: 'Approved',
            startDate: { $lte: targetDate },
            endDate: { $gte: targetDate }
        });

        const excludedWorkerIds = activeLeaves.map(leave => leave.labour.toString());

        res.json({
            records,
            excludedWorkerIds
        });
    } catch (err) {
        console.error('Fetch daily attendance error:', err.message);
        res.status(500).send('Server Error');
    }
});

// @route   POST /api/attendance
// @desc    Mark attendance for a labourer for a specific day
// @access  Private
router.post('/', auth, async (req, res) => {
    try {
        const { labourId, date, status, hours, siteId } = req.body;

        if (!labourId || !date || !status || !siteId) {
            return res.status(400).json({ message: 'Missing required attendance data (labour, date, status, siteId)' });
        }

        // Verify labour belongs to user
        const labour = await Labour.findById(labourId);
        if (!labour || labour.owner.toString() !== req.user.userId) {
            return res.status(404).json({ message: 'Worker not found' });
        }

        // Strip time from date to normalize it
        const targetDate = new Date(date);
        targetDate.setUTCHours(0, 0, 0, 0);

        // Enforcement: Check if attendance already exists for this worker on this date at DIFFERENT site
        const existingRecord = await Attendance.findOne({
            labour: labourId,
            date: targetDate,
            owner: req.user.userId
        });

        if (existingRecord && existingRecord.site.toString() !== siteId && status !== 'Absent') {
            // If marking something other than 'Absent', and already exists at another site, block it.
            // Note: We allow marking 'Absent' if they want to 'clear' it, but usually people just edit.
            // Actually, let's keep it strictly one site as per user request.
            return res.status(400).json({
                message: 'Attendance already recorded at another site for this worker on this date.',
                existingSiteId: existingRecord.site
            });
        }

        // Upsert (Update if exists, insert if new)
        const record = await Attendance.findOneAndUpdate(
            {
                labour: labourId,
                date: targetDate,
                owner: req.user.userId
            },
            {
                status: status,
                hours: hours || 0, // Save hours worked (especially for OT)
                site: siteId
            },
            { new: true, upsert: true }
        );

        res.json(record);
    } catch (err) {
        console.error('Mark attendance error:', err.message);
        res.status(500).send('Server Error');
    }
});

// @route   DELETE /api/attendance/:labourId/:date
// @desc    Delete or reset attendance for a labourer for a specific day
// @access  Private
router.delete('/:labourId/:date', auth, async (req, res) => {
    try {
        const { labourId, date } = req.params;

        const targetDate = new Date(date);
        targetDate.setUTCHours(0, 0, 0, 0);

        await Attendance.findOneAndDelete({
            labour: labourId,
            date: targetDate,
            owner: req.user.userId
        });

        res.json({ message: 'Attendance reset successfully' });
    } catch (err) {
        console.error('Reset attendance error:', err.message);
        res.status(500).send('Server Error');
    }
});

module.exports = router;
