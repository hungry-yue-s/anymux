import express, { Router } from 'express';
import multer from 'multer';
import { MAX_WALLPAPER_BYTES } from '../appearance.js';

export function createAppearanceRouter(store) {
  const router = Router();
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_WALLPAPER_BYTES },
  });

  router.get('/', async (_req, res, next) => {
    try {
      await store.ready();
      const customWallpapers = await store.listWallpapers();
      res.json({
        success: true,
        data: { config: store.getConfig(), customWallpapers },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  });

  router.put('/', express.json({ limit: '256kb' }), async (req, res, next) => {
    try {
      const config = await store.updateConfig(req.body || {});
      res.json({
        success: true,
        data: { config },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/wallpapers', upload.single('file'), async (req, res, next) => {
    try {
      if (!req.file) {
        res.status(400).json({ success: false, data: null, error: 'No file provided' });
        return;
      }
      const wallpaper = await store.saveWallpaper(req.file.buffer, req.file.originalname);
      const customWallpapers = await store.listWallpapers();
      res.status(201).json({
        success: true,
        data: { wallpaper, customWallpapers },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/wallpapers/:id', async (req, res, next) => {
    try {
      const found = await store.resolveWallpaperFile(req.params.id);
      if (!found) {
        res.status(404).json({ success: false, data: null, error: 'Wallpaper not found' });
        return;
      }
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
      res.type(found.mime);
      if (found.buffer) {
        res.send(found.buffer);
      } else {
        res.sendFile(found.filePath);
      }
    } catch (err) {
      next(err);
    }
  });

  router.delete('/wallpapers/:id', async (req, res, next) => {
    try {
      const deleted = await store.deleteWallpaper(req.params.id);
      if (!deleted) {
        res.status(404).json({ success: false, data: null, error: 'Wallpaper not found' });
        return;
      }
      const customWallpapers = await store.listWallpapers();
      res.json({
        success: true,
        data: { deleted: req.params.id, config: store.getConfig(), customWallpapers },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  });

  router.use((err, _req, res, _next) => {
    if (err.code === 'LIMIT_FILE_SIZE' || err.status === 413) {
      res.status(413).json({ success: false, data: null, error: 'Wallpaper exceeds 10MB limit' });
      return;
    }
    if (err.status === 400) {
      res.status(400).json({ success: false, data: null, error: err.message });
      return;
    }
    res.status(err.status || 500).json({ success: false, data: null, error: err.message || 'Internal error' });
  });

  return router;
}
