const express = require('express');

module.exports = function (dependencies) {
    const router = express.Router();
    
    const {
        requireAuth,
        database
    } = dependencies;

    // GET /api/tags
    router.get('/', requireAuth, (req, res) => {
        try {
            const rows = database.db.prepare('SELECT * FROM tags ORDER BY name ASC').all();
            res.json(rows);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // POST /api/tags
    router.post('/', requireAuth, (req, res) => {
        const { name, color } = req.body;
        if (!name) return res.status(400).json({ error: 'Name is required' });
        try {
            database.db.prepare('INSERT INTO tags (name, color) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET color = excluded.color').run(name, color || '#6366f1');
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // DELETE /api/tags/:id
    router.delete('/:id', requireAuth, (req, res) => {
        try {
            database.db.prepare('DELETE FROM tags WHERE id = ?').run(req.params.id);
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    return router;
};
