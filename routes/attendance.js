const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const Attendance = require('../models/Attendance');
const Labour = require('../models/Labour');
const Leave = require('../models/Leave');
const Site = require('../models/Site');
const mongoose = require('mongoose');

// Helper: get the site IDs a Manager is assigned to
const getManagerSiteIds = async (managerId, ownerId) => {
    const sites = await Site.find({ owner: ownerId, assignedManagers: managerId }).select('_id');
    return sites.map(s => s._id);
};

// @route   GET /api/attendance/summary/:labourId/:year/:month
// @desc    Get monthly calendar attendance summary for a specific labourer
// @access  Private
router.get('/summary/:labourId/:year/:month', auth, async (req, res) => {
    try {
        const { labourId, year, month } = req.params;
        const ownerId = req.user.effectiveOwnerId;

        const labour = await Labour.findOne({ _id: labourId, owner: ownerId });
        if (!labour) return res.status(404).json({ message: 'Worker not found' });

        const startDate = new Date(year, month - 1, 1);
        const endDate = new Date(year, month, 0, 23, 59, 59);

        const attendanceRecords = await Attendance.find({
            labour: labourId,
            owner: ownerId,
            date: { $gte: startDate, $lte: endDate }
        }).populate('site', 'name');

        const calendarMap = {};
        const stats = { present: 0, absent: 0, halfDay: 0, overtime: 0, overtimeHours: 0 };

        attendanceRecords.forEach(record => {
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
                if (record.hours > 8) stats.overtimeHours += (record.hours - 8);
            }
        });

        res.json({ records: calendarMap, stats });
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
        const ownerId = req.user.effectiveOwnerId;
        const { date } = req.params;

        const targetDate = new Date(date);
        targetDate.setUTCHours(0, 0, 0, 0);

        let query = { owner: ownerId, date: targetDate };

        // Managers: only see records for their assigned sites
        if (req.user.role === 'Manager') {
            const assignedSiteIds = await getManagerSiteIds(req.user.userId, ownerId);
            query.site = { $in: assignedSiteIds };
        }

        const records = await Attendance.find(query)
            .populate('labour', 'name designation dailyRate');

        const leaveQuery = { owner: ownerId, status: 'Approved', startDate: { $lte: targetDate }, endDate: { $gte: targetDate } };
        if (req.user.role === 'Manager') {
            const assignedSiteIds = await getManagerSiteIds(req.user.userId, ownerId);
            leaveQuery.site = { $in: assignedSiteIds };
        }

        const activeLeaves = await Leave.find(leaveQuery);
        const excludedWorkerIds = activeLeaves.map(leave => leave.labour.toString());

        res.json({ records, excludedWorkerIds });
    } catch (err) {
        console.error('Fetch daily attendance error:', err.message);
        res.status(500).send('Server Error');
    }
});

// @route   POST /api/attendance
// @desc    Mark attendance for a labourer
// @access  Private
router.post('/', auth, async (req, res) => {
    try {
        const ownerId = req.user.effectiveOwnerId;
        const { labourId, date, status, hours, siteId } = req.body;

        if (!labourId || !date || !status || !siteId) {
            return res.status(400).json({ message: 'Missing required attendance data (labour, date, status, siteId)' });
        }

        // Verify labour belongs to effective owner
        const labour = await Labour.findOne({ _id: labourId, owner: ownerId });
        if (!labour) return res.status(404).json({ message: 'Worker not found' });

        // Managers: verify the site is one of their assigned sites
        if (req.user.role === 'Manager') {
            const assignedSiteIds = (await getManagerSiteIds(req.user.userId, ownerId)).map(id => id.toString());
            if (!assignedSiteIds.includes(siteId)) {
                return res.status(403).json({ message: 'You can only mark attendance for your assigned sites' });
            }
        }

        const targetDate = new Date(date);
        targetDate.setUTCHours(0, 0, 0, 0);

        const existingRecord = await Attendance.findOne({ labour: labourId, date: targetDate, owner: ownerId });

        if (existingRecord && existingRecord.site.toString() !== siteId && status !== 'Absent') {
            return res.status(400).json({
                message: 'Attendance already recorded at another site for this worker on this date.',
                existingSiteId: existingRecord.site
            });
        }

        const record = await Attendance.findOneAndUpdate(
            { labour: labourId, date: targetDate, owner: ownerId },
            { status, hours: hours || 0, site: siteId },
            { new: true, upsert: true }
        );

        res.json(record);
    } catch (err) {
        console.error('Mark attendance error:', err.message);
        res.status(500).send('Server Error');
    }
});

// @route   DELETE /api/attendance/:labourId/:date
// @desc    Delete/reset attendance for a labourer for a specific day
// @access  Private
router.delete('/:labourId/:date', auth, async (req, res) => {
    try {
        const ownerId = req.user.effectiveOwnerId;
        const { labourId, date } = req.params;

        const targetDate = new Date(date);
        targetDate.setUTCHours(0, 0, 0, 0);

        await Attendance.findOneAndDelete({ labour: labourId, date: targetDate, owner: ownerId });
        res.json({ message: 'Attendance reset successfully' });
    } catch (err) {
        console.error('Reset attendance error:', err.message);
        res.status(500).send('Server Error');
    }
});

module.exports = router;
