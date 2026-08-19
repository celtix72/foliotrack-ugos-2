'use strict';

const express = require('express');

/**
 * Notes Router
 * Dependencies injected via factory function.
 */
module.exports = function(dependencies) {
    const router = express.Router();
    const { requireAuth, database } = dependencies;

    // GET /api/notes — list all notes for current user
    router.get('/', requireAuth, (req, res) => {
        try {
            const notes = database.getNotes(req.user.id);
            res.json(notes);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // POST /api/notes — create a new note
    router.post('/', requireAuth, (req, res) => {
        try {
            const { title = '', content = '', color = '#3b82f6', pinned = false, asset_symbol = null } = req.body;
            const note = database.createNote(req.user.id, { title, content, color, pinned, asset_symbol });
            res.status(201).json(note);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // PUT /api/notes/:id — update a note
    router.put('/:id', requireAuth, (req, res) => {
        try {
            const id = parseInt(req.params.id, 10);
            const { title, content, color, pinned, asset_symbol } = req.body;
            const note = database.updateNote(id, req.user.id, { title, content, color, pinned, asset_symbol });
            if (!note) return res.status(404).json({ error: 'Note not found' });
            res.json(note);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // PATCH /api/notes/:id/pin — toggle pinned status
    router.patch('/:id/pin', requireAuth, (req, res) => {
        try {
            const id = parseInt(req.params.id, 10);
            const existing = database.getNote(id, req.user.id);
            if (!existing) return res.status(404).json({ error: 'Note not found' });
            const note = database.updateNote(id, req.user.id, { pinned: !existing.pinned });
            res.json(note);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // DELETE /api/notes/:id — delete a note
    router.delete('/:id', requireAuth, (req, res) => {
        try {
            const id = parseInt(req.params.id, 10);
            const deleted = database.deleteNote(id, req.user.id);
            if (!deleted) return res.status(404).json({ error: 'Note not found' });
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    return router;
};
