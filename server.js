const express = require('express');
const mongoose = require('mongoose');
const path = require('path');
const cors = require('cors');
require('dotenv').config();

const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/user');
const siteRoutes = require('./routes/site');
const labourRoutes = require('./routes/labour');
const attendanceRoutes = require('./routes/attendance');
const leavesRoutes = require('./routes/leaves');
const salariesRoutes = require('./routes/salaries');
const advancesRoutes = require('./routes/advances');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Database Connection
mongoose.connect(process.env.MONGODB_URI)
  .then(() => {
      console.log('Connected to MongoDB');
      // Proactively drop legacy salaries index if it exists in the remote deployment
      mongoose.connection.db.collection('salaries').dropIndex('labour_1_month_1_year_1')
        .then(() => console.log('Dropped obsolete salary index (labour_1_month_1_year_1)'))
        .catch(() => {}); // Ignore if already dropped or doesn't exist
  })
  .catch((err) => console.error('MongoDB connection error:', err));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/user', userRoutes);
app.use('/api/sites', siteRoutes);
app.use('/api/labours', labourRoutes);
app.use('/api/attendance', attendanceRoutes);
app.use('/api/leaves', leavesRoutes);
app.use('/api/salaries', salariesRoutes);
app.use('/api/advances', advancesRoutes);

// Basic route
app.get('/', (req, res) => {
  res.send('KarmSathi API is running');
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

module.exports = app;
