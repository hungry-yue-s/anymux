import { Router } from 'express';
import multer from 'multer';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB

export function sanitizeFilename(name) {
  const cleaned = name
    .replace(/[/\\]/g, '')
    .replace(/\.\./g, '')
    .replace(/[\x00-\x1f\x7f]/g, '');
  return cleaned || 'upload';
}

/**
 * The stored path as programs on this machine read it. Windows-native ones
 * (Claude Code, Codex) cannot open an MSYS path such as /tmp/x.png, and MSYS
 * shells accept C:/... too, so Windows gets the drive path with forward
 * slashes: pasted into either, it names the file and survives shell parsing.
 */
export function nativeFilePath(path, platform = process.platform) {
  return platform === 'win32' ? path.replace(/\\/g, '/') : path;
}

/**
 * @param {string} uploadDir native directory the files are written to
 * @param {{ displayPath?: (path: string) => string }} [options] maps the stored
 *   path to the one reported to the client (Windows reports MSYS paths)
 */
export function createUploadRouter(uploadDir, { displayPath = (path) => path } = {}) {
  mkdirSync(uploadDir, { recursive: true });

  const storage = multer.diskStorage({
    destination: (_req, _file, cb) => {
      // The panel runs for weeks: periodic tmp cleaners can remove the
      // directory after the router was created (macOS clears /tmp entries),
      // so re-create it before each stored file.
      try {
        mkdirSync(uploadDir, { recursive: true });
        cb(null, uploadDir);
      } catch (err) {
        cb(err);
      }
    },
    filename: (_req, file, cb) => {
      const timestamp = Date.now();
      let safe = sanitizeFilename(file.originalname);
      // NTFS rejects these characters in file names.
      if (process.platform === 'win32') safe = safe.replace(/[<>:"|?*]/g, '_');
      cb(null, `${timestamp}_${safe}`);
    },
  });

  const upload = multer({
    storage,
    limits: { fileSize: MAX_FILE_SIZE },
  });

  const router = Router();

  router.post('/', upload.single('file'), (req, res) => {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        data: null,
        error: 'No file provided',
      });
    }

    const stored = join(uploadDir, req.file.filename);
    res.json({
      success: true,
      // path: what a shell in a pane uses (MSYS on Windows).
      // nativePath: what a pasted image path must be for an agent to attach it.
      data: { path: displayPath(stored), nativePath: nativeFilePath(stored) },
      error: null,
    });
  });

  // Handle multer errors (file too large, etc.)
  router.use((err, _req, res, _next) => {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        success: false,
        data: null,
        error: 'File too large (max 20MB)',
      });
    }
    res.status(500).json({
      success: false,
      data: null,
      error: err.message,
    });
  });

  return router;
}
