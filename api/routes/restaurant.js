const express = require('express');
const router = express.Router();

router.get('/menu', (req, res) => {
    res.json({ message: 'Restaurant menu endpoint' });
});

module.exports = router;