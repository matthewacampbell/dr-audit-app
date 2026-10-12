const express = require('express');
const db = require('../db');
const storage = require('../storage');
const { requireLogin, wrap } = require('../middleware');

const router = express.Router();
router.use(requireLogin);

// Screenshots are never public. They're streamed through the app, so only signed-in
// employees can see them, and the storage server only has to be reachable from here.
router.get(
  '/:id',
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const shot = Number.isInteger(id)
      ? db.prepare('SELECT storage_key, content_type FROM screenshots WHERE id = ?').get(id)
      : null;
    if (!shot) return res.status(404).type('text').send('Not found');

    let file;
    try {
      file = await storage.get(shot.storage_key);
    } catch (err) {
      if (storage.isMissing(err)) return res.status(404).type('text').send('Image file not found');
      console.error('Storage get failed:', err);
      return res.status(502).type('text').send('Image storage is unavailable');
    }

    res.set('Content-Type', shot.content_type);
    res.set('Cache-Control', 'private, max-age=86400');
    if (file.size) res.set('Content-Length', String(file.size));
    file.stream.on('error', (err) => {
      console.error('Storage stream error:', err);
      res.destroy(err);
    });
    file.stream.pipe(res);
  })
);

module.exports = router;
