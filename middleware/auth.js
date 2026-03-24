const jwt = require('jsonwebtoken');

module.exports = function (req, res, next) {
    // Get token from header
    const token = req.header('Authorization')?.replace('Bearer ', '');

    // Check if not token
    if (!token) {
        return res.status(401).json({ message: 'No token, authorization denied' });
    }

    try {
        // Verify token
        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        // Add user from payload
        req.user = decoded;

        // KEY LOGIC: Managers act on behalf of their Owner.
        // effectiveOwnerId is used for ALL database queries so data always
        // belongs to the correct Owner regardless of who (Owner or Manager) creates it.
        if (decoded.role === 'Manager' && decoded.ownerId) {
            req.user.effectiveOwnerId = decoded.ownerId;
        } else {
            req.user.effectiveOwnerId = decoded.userId;
        }

        next();
    } catch (err) {
        res.status(401).json({ message: 'Token is not valid' });
    }
};
