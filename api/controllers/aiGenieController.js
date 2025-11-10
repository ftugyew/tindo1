const { generateResponse } = require('../utils/aiHelper');

// Controller for AI Genie
module.exports = {
    handleQuery: async (req, res) => {
        const { query } = req.body;
        try {
            const reply = await generateResponse(query);
            res.json({ reply });
        } catch (error) {
            console.error('AI Genie Error:', error);
            res.status(500).json({ error: 'Failed to process your request. Please try again later.' });
        }
    }
};