const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const Salary = require('../models/Salary');
const Labour = require('../models/Labour');
const Attendance = require('../models/Attendance');
const Advance = require('../models/Advance');

// @route   POST /api/salaries/calculate
// @desc    Calculate and generate salaries for all workers at a specific site for a given month/year
// @access  Private
router.post('/calculate', auth, async (req, res) => {
    try {
        const { siteId, month, year } = req.body;

        if (!siteId || !month || !year) {
            return res.status(400).json({ message: 'Site, month, and year are required' });
        }

        // Get all workers assigned to this site (check if siteId is in their sites array)
        const workers = await Labour.find({ sites: siteId, owner: req.user.userId });

        if (workers.length === 0) {
            return res.status(404).json({ message: 'No workers found at this site' });
        }

        // Define date boundaries for the month
        const startDate = new Date(year, month - 1, 1);
        const endDate = new Date(year, month, 0, 23, 59, 59);

        const generatedSalaries = [];

        for (const worker of workers) {
            // Find attendance records for this month for this site
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
                    presentDays += 1; // Overtime inherently means they were present
                    if (record.hours > 8) {
                        totalOvertimeHours += (record.hours - 8);
                    }
                }
            });

            // Safeguard against missing dailyRate issues
            const dailyRate = Number(worker.dailyRate) || 0;
            const basicSalary = Number((presentDays * dailyRate).toFixed(2)) || 0;
            const hourlyRate = dailyRate / 8;
            const overtimePay = Number((totalOvertimeHours * hourlyRate).toFixed(2)) || 0;

            // Check if a salary record already exists for this site, month, year, worker
            let existingSalary = await Salary.findOne({
                labour: worker._id,
                site: siteId,
                month,
                year,
                owner: req.user.userId
            });

            let totalAdvanceToDeduct = existingSalary ? Number(existingSalary.advanceTaken || 0) : 0;
            let pendingAdvances = [];

            if (!existingSalary) {
                // If it's a completely new calculation, fetch Pending advances
                pendingAdvances = await Advance.find({
                    labour: worker._id,
                    site: siteId,
                    status: 'Pending',
                    dateGiven: { $lte: endDate }
                });

                // Sum the advances
                pendingAdvances.forEach(adv => {
                    totalAdvanceToDeduct += Number(adv.amount || 0);
                });
            }

            let netPayable = Number((basicSalary + overtimePay - totalAdvanceToDeduct).toFixed(2)) || 0;
            if (netPayable < 0 || isNaN(netPayable)) netPayable = 0;

            if (existingSalary) {
                // Update existing safely
                existingSalary.presentDays = presentDays;
                existingSalary.basicSalary = basicSalary;
                existingSalary.totalOvertimeHours = totalOvertimeHours;
                existingSalary.overtimePay = overtimePay;
                existingSalary.netPayable = netPayable;
                // Leave advanceTaken and status alone

                await existingSalary.save();
                generatedSalaries.push(existingSalary);
            } else {
                // Insert fresh salary record
                const newSalary = new Salary({
                    labour: worker._id,
                    site: siteId,
                    month,
                    year,
                    owner: req.user.userId,
                    presentDays,
                    basicSalary,
                    totalOvertimeHours,
                    overtimePay,
                    advanceTaken: totalAdvanceToDeduct,
                    netPayable,
                    status: 'Pending'
                });

                await newSalary.save();

                // Mark advances as Deducted for newly consumed pending advances
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
// @desc    Get all calculated salaries, optionally filtered by site, month, year
// @access  Private
router.get('/', auth, async (req, res) => {
    try {
        const { siteId, month, year } = req.query;
        let query = { owner: req.user.userId };

        if (siteId) {
            query.site = siteId;
        }
        if (month) query.month = parseInt(month);
        if (year) query.year = parseInt(year);

        query.isArchivedFromGlobal = { $ne: true };

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
        const salaries = await Salary.find({ labour: req.params.labourId, owner: req.user.userId, status: 'Paid' })
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
// @desc    Update a salary record (e.g. tracking Advance taken or Status)
// @access  Private
router.put('/:id', auth, async (req, res) => {
    try {
        const { advanceTaken, status } = req.body;

        let salary = await Salary.findById(req.params.id);
        if (!salary) return res.status(404).json({ message: 'Salary record not found' });
        if (salary.owner.toString() !== req.user.userId) return res.status(401).json({ message: 'Not authorized' });

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

        // Return populated document for frontend
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
// @desc    Delete a salary record
// @access  Private
router.delete('/:id', auth, async (req, res) => {
    try {
        const { global } = req.query;
        const salary = await Salary.findById(req.params.id);

        if (!salary) return res.status(404).json({ message: 'Salary record not found' });
        if (salary.owner.toString() !== req.user.userId) return res.status(401).json({ message: 'Not authorized' });

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
