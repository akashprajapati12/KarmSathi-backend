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
            // Find attendance records for this month
            const attendanceRecords = await Attendance.find({
                labour: worker._id,
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

            const basicSalary = presentDays * worker.dailyRate;

            // Assuming 8 hours is standard workday. Hourly rate = dailyRate / 8.
            const hourlyRate = worker.dailyRate / 8;
            const overtimePay = totalOvertimeHours * hourlyRate;

            // Get pending advances for this worker given BEFORE or ON the end of this month
            // We use endDate to ensure we only sum advances given up to that salary month
            const pendingAdvances = await Advance.find({
                labour: worker._id,
                status: 'Pending',
                dateGiven: { $lte: endDate }
            });

            // Sum the advances
            let totalAdvanceToDeduct = 0;
            pendingAdvances.forEach(adv => {
                totalAdvanceToDeduct += adv.amount;
            });

            const netPayable = basicSalary + overtimePay - totalAdvanceToDeduct;

            // Upsert the salary record
            const salary = await Salary.findOneAndUpdate(
                { labour: worker._id, month, year, owner: req.user.userId },
                {
                    site: siteId,
                    presentDays,
                    basicSalary,
                    totalOvertimeHours,
                    overtimePay,
                    netPayable,
                    // If inserting fresh, set advanceTaken to the sum we just calculated
                    // If updating an existing record, we don't overwrite manual edits to advanceTaken
                    $setOnInsert: { advanceTaken: totalAdvanceToDeduct, status: 'Pending' }
                },
                { new: true, upsert: true }
            );

            // If we utilized advances for this new salary calculation, mark them as Deducted
            if (totalAdvanceToDeduct > 0 && salary.status === 'Pending') {
                // Technically, if they recalculate, we don't want to re-deduct.
                // This logic safely marks them deducted once the salary is officially created.
                await Advance.updateMany(
                    { _id: { $in: pendingAdvances.map(a => a._id) } },
                    { $set: { status: 'Deducted' } }
                );
            }

            generatedSalaries.push(salary);
        }

        res.json({ message: 'Salaries calculated successfully', count: generatedSalaries.length });

    } catch (err) {
        console.error('Calculate salaries error:', err.message);
        res.status(500).send('Server Error');
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
            const workersAtSite = await Labour.find({ sites: siteId, owner: req.user.userId }).select('_id');
            query.labour = { $in: workersAtSite.map(w => w._id) };
        }
        if (month) query.month = parseInt(month);
        if (year) query.year = parseInt(year);

        const salaries = await Salary.find(query)
            .populate('labour', 'name designation mobileNumber dailyRate')
            .populate('site', 'name address')
            .populate('owner', 'name')
            .sort({ year: -1, month: -1 });

        res.json(salaries);
    } catch (err) {
        console.error('Fetch salaries error:', err.message);
        res.status(500).send('Server Error');
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
        res.status(500).send('Server Error');
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
            salary.netPayable = salary.basicSalary + salary.overtimePay - salary.advanceTaken;
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
        res.status(500).send('Server Error');
    }
});

// @route   DELETE /api/salaries/:id
// @desc    Delete a salary record
// @access  Private
router.delete('/:id', auth, async (req, res) => {
    try {
        const salary = await Salary.findById(req.params.id);

        if (!salary) return res.status(404).json({ message: 'Salary record not found' });
        if (salary.owner.toString() !== req.user.userId) return res.status(401).json({ message: 'Not authorized' });

        await salary.deleteOne();
        res.json({ message: 'Salary record removed' });
    } catch (err) {
        console.error('Delete salary error:', err.message);
        res.status(500).send('Server Error');
    }
});

module.exports = router;
