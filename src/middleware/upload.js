const multer = require('multer');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const env = require('../config/env');
const ApiError = require('../utils/ApiError');

/**
 * Local-disk storage for MVP simplicity. Swap the `storage` engine for
 * multer-s3 (or similar) when you move to cloud storage — everything else
 * (routes, controllers) stays the same since they only ever see
 * `req.file.filename` / the resulting public URL, not the storage details.
 */
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, env.uploads.dir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${uuidv4()}${ext}`);
  },
});

const allowedMimeTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);

function fileFilter(req, file, cb) {
  if (!allowedMimeTypes.has(file.mimetype)) {
    return cb(ApiError.badRequest('Only JPEG, PNG, and WebP images are allowed'));
  }
  cb(null, true);
}

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: env.uploads.maxSizeMb * 1024 * 1024 },
});

module.exports = upload;
