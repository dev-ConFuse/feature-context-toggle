/**
 * Feature Toggle - Backend Entry Point
 * 
 * Express server for managing feature toggles with PostgreSQL and in-memory caching.
 */

import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadConfig, getConfig } from './config.js';
import { getDb } from './db/client.js';
import { cache } from './cache.js';
import toggleRoutes from './routes/toggles-db.js';
import type { HealthResponse } from './types/index.js';
import { logger } from './utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Try resolving local .map.env, .secret.env and .env.local from backend dir and root dir
dotenv.config({ path: path.resolve(process.cwd(), '.map.env') });
dotenv.config({ path: path.resolve(process.cwd(), '.secret.env') });
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });
dotenv.config({ path: path.resolve(__dirname, '../../.map.env') });
dotenv.config({ path: path.resolve(__dirname, '../../.secret.env') });
dotenv.config({ path: path.resolve(__dirname, '../../.env.local') });

// Load configuration first (validates required env vars)
logger.info('[STARTUP] Loading configuration...');
const appConfig = loadConfig();
logger.info('[STARTUP] Configuration loaded successfully', { port: appConfig.port, nodeEnv: appConfig.nodeEnv });

const app = express();
const PORT = appConfig.port;
const VERSION = process.env.npm_package_version || '1.0.0';

// =============================================================================
// Security Middleware
// =============================================================================
// @ts-ignore - helmet type mismatch workaround
app.use(helmet());

// =============================================================================
// CORS Configuration
// =============================================================================
const corsOrigins = appConfig.corsOrigins;

// Handle wildcard CORS for development (credentials: true requires dynamic origin)
const corsOriginHandler = corsOrigins.includes('*')
    ? (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
        // Allow all origins in development mode
        callback(null, true);
    }
    : corsOrigins;

app.use(cors({
    origin: corsOriginHandler,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
}));

// =============================================================================
// Body Parsing
// =============================================================================
app.use(express.json());

// =============================================================================
// Request Logging
// =============================================================================
// Health Check
// =============================================================================
app.get('/health', async (_req, res) => {
    logger.debug('[HEALTH] Health check requested');
    const dbHealth = await getDb().healthCheck();
    const cacheHealth = await cache.healthCheck();
    logger.debug('[HEALTH] Health check results', { dbHealth, cacheHealth });

    const isHealthy = dbHealth.healthy;
    const status = isHealthy ? 'healthy' : (cacheHealth.healthy ? 'degraded' : 'unhealthy');

    const response: HealthResponse = {
        status,
        service: 'feature-toggle',
        version: VERSION,
        timestamp: new Date().toISOString(),
        dependencies: {
            database: dbHealth,
            cache: cacheHealth,
        },
    };

    logger.debug(`[HEALTH] Responding with status: ${status}`);
    res.status(isHealthy ? 200 : 503).json(response);
});

// =============================================================================
// Toggle Routes
// =============================================================================
app.use('/api/toggles', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    next();
}, toggleRoutes);

// =============================================================================
// Static Files - Serve Frontend Dashboard
// =============================================================================
const originalPublicPath = path.join(__dirname, '..', 'public');
app.use(express.static(originalPublicPath));

// SPA fallback - serve index.html for all non-API routes
app.use((req, res, next) => {
    if (req.method !== 'GET') return next();
    // Skip API routes
    if (req.path.startsWith('/api') || req.path === '/health') {
        return next();
    }
    res.sendFile(path.join(originalPublicPath, 'index.html'), (err) => {
        if (err) {
            // If index.html doesn't exist, return 404
            res.status(404).json({
                success: false,
                error: 'Frontend not available',
                message: 'The dashboard UI is not built. Run: cd frontend && npm run build',
                path: req.path,
                timestamp: new Date().toISOString(),
            });
        }
    });
});

// =============================================================================
// 404 Handler (for API routes only)
// =============================================================================
app.use((req, res) => {
    logger.warn(`[404] Not found: ${req.path}`);
    res.status(404).json({
        success: false,
        error: 'Not found',
        path: req.path,
        timestamp: new Date().toISOString(),
    });
});

// =============================================================================
// Error Handler
// =============================================================================
app.use((err: Error & { type?: string; status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    // Classify client-body errors instead of masking them as internal faults
    // (same contract as the auth-middleware error handler).
    if (err.type === 'entity.parse.failed') {
        return res.status(400).json({
            success: false,
            error: 'Invalid JSON body',
            timestamp: new Date().toISOString(),
        });
    }
    if (err.type === 'entity.too.large') {
        return res.status(413).json({
            success: false,
            error: 'Payload too large',
            timestamp: new Date().toISOString(),
        });
    }
    if (err.type === 'encoding.unsupported') {
        return res.status(415).json({
            success: false,
            error: 'Unsupported encoding',
            timestamp: new Date().toISOString(),
        });
    }
    const status = err.status && err.status >= 400 && err.status < 500 ? err.status : 500;
    logger.error('Unhandled error:', err);
    res.status(status).json({
        success: false,
        error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message,
        timestamp: new Date().toISOString(),
    });
});

// =============================================================================
// Startup
// =============================================================================
async function start() {
    logger.info('[STARTUP] ==================================================');
    logger.info('[STARTUP] Feature Toggle Service Starting...');
    logger.info('[STARTUP] ==================================================');
    logger.info(`[STARTUP] Timestamp: ${new Date().toISOString()}`);
    logger.info(`[STARTUP] Node version: ${process.version}`);
    logger.info(`[STARTUP] Environment: ${appConfig.nodeEnv}`);
    logger.info('');
    logger.info('╔══════════════════════════════════════════════════════════╗');
    logger.info('║     🎛️  Feature Toggle - Starting...             ║');
    logger.info('╚══════════════════════════════════════════════════════════╝');
    logger.info('');

    // Initialize database
    logger.info('[STARTUP] Initializing database connection...');
    const dbReady = await getDb().initialize();
    if (!dbReady) {
        logger.warn('[STARTUP] ⚠️  Database initialization failed, running in degraded mode');
    } else {
        logger.info('[STARTUP] ✅ Database initialized successfully');
    }

    // Initialize cache
    logger.info('[STARTUP] Initializing cache...');
    const cacheReady = await cache.initialize();
    if (!cacheReady) {
        logger.warn('[STARTUP] ⚠️  Cache not available, running without caching');
    } else {
        logger.info('[STARTUP] ✅ Cache initialized successfully');
    }

    // Start server
    app.listen(PORT, () => {
        logger.info(`🚀 Server running on http://localhost:${PORT}`);
    });
}

// Graceful shutdown
process.on('SIGTERM', async () => {
    logger.info('[SHUTDOWN] Received SIGTERM, shutting down gracefully...');
    logger.info(`[SHUTDOWN] Timestamp: ${new Date().toISOString()}`);
    await cache.close();
    await getDb().close();
    process.exit(0);
});

process.on('SIGINT', async () => {
    logger.info('[SHUTDOWN] Received SIGINT, shutting down gracefully...');
    logger.info(`[SHUTDOWN] Timestamp: ${new Date().toISOString()}`);
    await cache.close();
    await getDb().close();
    process.exit(0);
});

// Start the server
start().catch((error) => {
    logger.error('Failed to start server:', error);
    process.exit(1);
});

export default app;
