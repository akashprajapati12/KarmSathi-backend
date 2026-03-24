const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const Salary = require('../models/Salary');
const Labour = require('../models/Labour');
const Attendance = require('../models/Attendance');
const Advance = require('../models/Advance');
const Site = require('../models/Site');

// Helper: get the site IDs a Manager is assigned to
const getManagerSiteIds = async (managerId, ownerId) => {
    const sites = await Site.find({ owner: ownerId, assignedManagers: managerId }).select('_id');
    return sites.map(s => s._id);
};

// @route   POST /api/salaries/calculate
// @desc    Calculate and generate salaries for all workers at a specific site for a given month/year
// @access  Private
router.post('/calculate', auth, async (req, res) => {
    try {
        const ownerId = req.user.effectiveOwnerId;
        const { siteId, month, year } = req.body;

        if (!siteId || !month || !year) {
            return res.status(400).json({ message: 'Site, month, and year are required' });
        }

        // Managers: verify they are allowed to calculate for this site
        if (req.user.role === 'Manager') {
            const assignedSiteIds = (await getManagerSiteIds(req.user.userId, ownerId)).map(id => id.toString());
            if (!assignedSiteIds.includes(siteId)) {
                return res.status(403).json({ message: 'You can only calculate salaries for your assigned sites' });
            }
        }

        const workers = await Labour.find({ sites: siteId, owner: ownerId });
        if (workers.length === 0) {
            return res.status(404).json({ message: 'No workers found at this site' });
        }

        const startDate = new Date(year, month - 1, 1);
        const endDate = new Date(year, month, 0, 23, 59, 59);
        const generatedSalaries = [];

        for (const worker of workers) {
            const attendanceRecords = await Attendance.find({
                labour: worker._id,
                site: siteId,
                date: { $gte: startDate, $lte: endDate }
            });

            let presentDays = 0;
            let totalOvertimeHours = 0;

            attendanceRecords.forEach(record => {
                if (record.status === 'Present') presentDays += 1;
                else if (record.status === 'Half Day') presentDays += 0.5;
                else if (record.status === 'Overtime') {
                    presentDays += 1;
                    if (record.hours > 8) totalOvertimeHours += (record.hours - 8);
                }
            });

            const dailyRate = Number(worker.dailyRate) || 0;
            const basicSalary = Number((presentDays * dailyRate).toFixed(2)) || 0;
            const hourlyRate = dailyRate / 8;
            const overtimePay = Number((totalOvertimeHours * hourlyRate).toFixed(2)) || 0;

            let existingSalary = await Salary.findOne({
                labour: worker._id,
                site: siteId,
                month,
                year,
                owner: ownerId
            });

            let totalAdvanceToDeduct = existingSalary ? Number(existingSalary.advanceTaken || 0) : 0;
            let pendingAdvances = [];

            if (!existingSalary) {
                pendingAdvances = await Advance.find({
                    labour: worker._id,
                    site: siteId,
                    status: 'Pending',
                    dateGiven: { $lte: endDate }
                });
                pendingAdvances.forEach(adv => {
                    totalAdvanceToDeduct += Number(adv.amount || 0);
                });
            }

            let netPayable = Number((basicSalary + overtimePay - totalAdvanceToDeduct).toFixed(2)) || 0;
            if (netPayable < 0 || isNaN(netPayable)) netPayable = 0;

            if (existingSalary) {
                existingSalary.presentDays = presentDays;
                existingSalary.basicSalary = basicSalary;
                existingSalary.totalOvertimeHours = totalOvertimeHours;
                existingSalary.overtimePay = overtimePay;
                existingSalary.netPayable = netPayable;
                await existingSalary.save();
                generatedSalaries.push(existingSalary);
            } else {
                const newSalary = new Salary({
                    labour: worker._id,
                    site: siteId,
                    month,
                    year,
                    owner: ownerId,   // Always under Owner's ID
                    presentDays,
                    basicSalary,
                    totalOvertimeHours,
                    overtimePay,
                    advanceTaken: totalAdvanceToDeduct,
                    netPayable,
                    status: 'Pending'
                });

                await newSalary.save();

                if (totalAdvanceToDeduct > 0) {
                    await Advance.updateMany(
                        { _id: { $in: pendingAdvances.map(a => a._id) } },
                        { $set: { status: 'Deducted' } }
                    );
                }

                generatedSalaries.push(newSalary);
            }
        }

        res.json({ message: 'Salaries calculated successfully', count: generatedSalaries.length });
    } catch (err) {
        console.error('Calculate salaries error:', err.message);
        res.status(500).json({ message: err.message || 'Server Error' });
    }
});

// @route   GET /api/salaries
// @desc    Get all calculated salaries — Managers see only their site's salaries
// @access  Private
router.get('/', auth, async (req, res) => {
    try {
        const ownerId = req.user.effectiveOwnerId;
        const { siteId, month, year } = req.query;
        let query = { owner: ownerId };

        if (siteId) query.site = siteId;
        if (month) query.month = parseInt(month);
        if (year) query.year = parseInt(year);

        query.isArchivedFromGlobal = { $ne: true };

        // Managers: scope to their assigned sites
        if (req.user.role === 'Manager') {
            const assignedSiteIds = await getManagerSiteIds(req.user.userId, ownerId);
            // If a specific siteId is requested, verify it's in their list
            if (siteId) {
                const allowed = assignedSiteIds.map(id => id.toString()).includes(siteId);
                if (!allowed) return res.status(403).json({ message: 'Access denied to this site' });
            } else {
                query.site = { $in: assignedSiteIds };
            }
        }

        const salaries = await Salary.find(query)
            .populate('labour', 'name designation mobileNumber dailyRate')
            .populate('site', 'name address')
            .populate('owner', 'name')
            .sort({ year: -1, month: -1 });

        res.json(salaries);
    } catch (err) {
        console.error('Fetch salaries error:', err.message);
        res.status(500).json({ message: err.message || 'Server Error' });
    }
});

// @route   GET /api/salaries/labour/:labourId
// @desc    Get salary history for a specific worker
// @access  Private
router.get('/labour/:labourId', auth, async (req, res) => {
    try {
        const ownerId = req.user.effectiveOwnerId;

        const salaries = await Salary.find({ labour: req.params.labourId, owner: ownerId, status: 'Paid' })
            .populate('labour', 'name designation mobileNumber dailyRate')
            .populate('site', 'name address')
            .populate('owner', 'name')
            .sort({ year: -1, month: -1 });

        res.json(salaries);
    } catch (err) {
        console.error('Fetch salary history error:', err.message);
        res.status(500).json({ message: err.message || 'Server Error' });
    }
});

// @route   PUT /api/salaries/:id
// @desc    Update a salary record (advance taken or status)
// @access  Private
router.put('/:id', auth, async (req, res) => {
    try {
        const ownerId = req.user.effectiveOwnerId;
        const { advanceTaken, status } = req.body;

        let salary = await Salary.findOne({ _id: req.params.id, owner: ownerId });
        if (!salary) return res.status(404).json({ message: 'Salary record not found' });

        // Managers: verify site access
        if (req.user.role === 'Manager') {
            const assignedSiteIds = (await getManagerSiteIds(req.user.userId, ownerId)).map(id => id.toString());
            if (!assignedSiteIds.includes(salary.site.toString())) {
                return res.status(403).json({ message: 'Access denied' });
            }
        }

        if (advanceTaken !== undefined) {
            salary.advanceTaken = advanceTaken;
            salary.netPayable = Number((salary.basicSalary + salary.overtimePay - salary.advanceTaken).toFixed(2));
            if (salary.netPayable < 0) salary.netPayable = 0;
        }

        if (status) {
            if (!['Pending', 'Paid'].includes(status)) return res.status(400).json({ message: 'Invalid status' });
            salary.status = status;
        }

        await salary.save();

        salary = await Salary.findById(salary._id)
            .populate('labour', 'name designation mobileNumber dailyRate')
            .populate('site', 'name address')
            .populate('owner', 'name');

        res.json(salary);
    } catch (err) {
        console.error('Update salary error:', err.message);
        res.status(500).json({ message: err.message || 'Server Error' });
    }
});

// @route   DELETE /api/salaries/:id
// @desc    Delete a salary record (Owner only)
// @access  Private
router.delete('/:id', auth, async (req, res) => {
    try {
        if (req.user.role === 'Manager') {
            return res.status(403).json({ message: 'Managers cannot delete salary records' });
        }

        const salary = await Salary.findOne({ _id: req.params.id, owner: req.user.userId });
        if (!salary) return res.status(404).json({ message: 'Salary record not found' });

        const { global } = req.query;
        if (global === 'true' && salary.status === 'Paid') {
            salary.isArchivedFromGlobal = true;
            await salary.save();
            return res.json({ message: 'Salary record hidden from global view' });
        }

        await salary.deleteOne();
        res.json({ message: 'Salary record removed' });
    } catch (err) {
        console.error('Delete salary error:', err.message);
        res.status(500).json({ message: err.message || 'Server Error' });
    }
});

module.exports = router;
