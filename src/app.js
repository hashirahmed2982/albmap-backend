const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const path = require('path');

const env = require('./config/env');
const routes = require('./routes');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');
const ApiError = require('./utils/ApiError');

const app = express();

// Trusts exactly one hop of reverse proxy (nginx sitting in front of this
// process on the same box — see the deploy setup). Without this, Express
// ignores X-Forwarded-For entirely and req.ip resolves to the proxy's own
// address for every request, which breaks express-rate-limit two ways at
// once: every client gets lumped into one shared rate-limit bucket keyed
// off the proxy's IP, AND express-rate-limit's own startup validation
// throws ERR_ERL_UNEXPECTED_X_FORWARDED_FOR on every request because it
// sees a forwarded-for header arrive despite trust proxy being unset —
// which is exactly what showed up in production logs.
//
// Using the numeric hop count `1` rather than `true` is deliberate:
// `true` trusts every hop in the chain, including ones a client could
// forge if they can reach this process directly (bypassing nginx) or if
// there's ever more than one proxy in front later — trusting only the
// nearest hop means Express reads the *last* IP nginx itself appended to
// X-Forwarded-For, not whatever a client claims further up the chain.
app.set('trust proxy', 1);

// ---------------- Security & parsing ----------------
app.use(helmet());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// CORS: mobile app has no Origin header (native HTTP client), so it's
// unaffected either way. The website and admin portal DO send an Origin
// header from the browser — only origins listed in CORS_ALLOWED_ORIGINS
// are permitted, everything else (including "no origin" from tools like
// curl/Postman) is allowed through unless you tighten this further.
app.use(
  cors({
    origin(origin, callback) {
      if (!origin || env.cors.allowedOrigins.length === 0 || env.cors.allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new ApiError(403, 'Not allowed by CORS'));
    },
    credentials: true,
  }),
);

app.use(morgan(env.isProduction ? 'combined' : 'dev'));

// Rate limiting — generic API-wide ceiling. Add stricter per-route limits
// (e.g. on /auth/login) if you see brute-force attempts in logs.
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
  }),
);

// ---------------- Static file serving (uploaded logos/images) ----------------
app.use(`/${env.uploads.dir}`, express.static(path.join(process.cwd(), env.uploads.dir)));

// ---------------- Health check (for load balancers / uptime monitors) ----------------
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

// ---------------- API routes ----------------
// Mounted under /v1 to match the mobile app's baseUrl convention
// (see lib/core/constants/app_constants.dart — defaultValue ends in /v1).
app.use('/v1', routes);

// ---------------- 404 + error handling (must be registered last) ----------------
app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
