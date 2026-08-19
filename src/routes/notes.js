'use strict';

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Ensure uploads directory exists
const uploadDir = path.join(__dirname, '..', '..', 'uploads', 'notes');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, uploadDir)
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9)
        cb(null, uniqueSuffix + path.extname(file.originalname))
    }
});

// Configure multer limits and filter
const upload = multer({ 
    storage: storage,
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        // Block executables
        if (['.exe', '.sh', '.bat', '.cmd', '.msi', '.app'].includes(ext)) {
            return cb(new Error('File type not allowed'));
        }
        cb(null, true);
    }
});

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

    // POST /api/notes/:id/attachments — upload an attachment
    router.post('/:id/attachments', requireAuth, upload.single('file'), (req, res) => {
        try {
            const id = parseInt(req.params.id, 10);
            const existing = database.getNote(id, req.user.id);
            if (!existing) {
                // Remove file if note doesn't exist
                if (req.file) fs.unlinkSync(req.file.path);
                return res.status(404).json({ error: 'Note not found' });
            }
            if (!req.file) {
                return res.status(400).json({ error: 'No file uploaded' });
            }
            
            const attachment = database.addNoteAttachment(
                id, 
                req.file.originalname, 
                req.file.filename, 
                req.file.mimetype, 
                req.file.size
            );
            res.status(201).json(attachment);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // DELETE /api/notes/:id/attachments/:attachmentId — delete an attachment
    router.delete('/:id/attachments/:attachmentId', requireAuth, (req, res) => {
        try {
            const id = parseInt(req.params.id, 10);
            const attachmentId = parseInt(req.params.attachmentId, 10);
            
            const note = database.getNote(id, req.user.id);
            if (!note) return res.status(404).json({ error: 'Note not found' });
            
            const attachment = database.getNoteAttachment(attachmentId);
            if (!attachment || attachment.note_id !== id) {
                return res.status(404).json({ error: 'Attachment not found' });
            }
            
            const filePath = path.join(uploadDir, attachment.stored_name);
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
            
            database.deleteNoteAttachment(attachmentId);
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    return router;
};
