/**
 * Feature Toggle - Configuration Module
 * 
 * Centralized configuration loader with environment variable validation.
 * All configuration values are loaded from environment variables.
 */

import { logger } from './utils/logger.js';

// =============================================================================
// Configuration Interface
// =============================================================================

export interface Config {
    // Server
    port: number;
    nodeEnv: string;
    isProduction: boolean;

    // Database
    db: {
        host: string;
        port: number;
        name: string;
        user: string;
        password?: string;
        schema: string;
        ssl: boolean;
        /** pg connect timeout in ms — sized to the slow runtime→Neon handshake. */
        connectionTimeoutMs: number;
        /** Upper bound in ms for the /health DB probe (liveness stays fast). */
        healthTimeoutMs: number;
        /** Warm connections kept open across idle gaps (avoid cold connects). */
        poolMin: number;
        poolMax: number;
        /** Idle connections above `poolMin` are reaped after this long. */
        poolIdleTimeoutMs: number;
        /** TCP keepalive probe delay — defeats idle NAT/flow expiry on the path. */
        keepAliveDelayMs: number;
        /** Client-side abort for in-flight queries (dead-connection hangs). */
        queryTimeoutMs: number;
        /** Transient-failure retries for DB operations (see db/client.ts). */
        retryAttempts: number;
        retryDelayMs: number;
    };

    // Cache
    cacheTtlSeconds: number;
    cacheKeyPrefix: string;
    allTogglesKey: string;

    // CORS
    corsOrigins: string[];

    // Validation
    validation: {
        minNameLength: number;
        maxNameLength: number;
        minDescriptionLength: number;
        maxDescriptionLength: number;
    };

    // API Limits
    apiLimits: {
        defaultAuditLimit: number;
        maxAuditLimit: number;
        defaultHistoryLimit: number;
        maxHistoryLimit: number;
    };
}

// =============================================================================
// Environment Variable Helpers
// =============================================================================

/**
 * Get required environment variable or throw error
 */
function getRequired(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
}

/**
 * Get integer environment variable
 */
function getInt(name: string): number {
    const value = process.env[name];
    if (!value) {
        throw new Error(`Missing required integer environment variable: ${name}`);
    }
    const parsed = parseInt(value, 10);
    if (isNaN(parsed)) {
        throw new Error(`Invalid integer for ${name}: ${value}`);
    }
    return parsed;
}

// =============================================================================
// Configuration Loader
// =============================================================================

let _config: Config | null = null;

/**
 * Load configuration from environment variables
 */
export function loadConfig(): Config {
    if (_config) return _config;

    const nodeEnv = getRequired('NODE_ENV');

    _config = {
        // Server
        port: getInt('FEATURE_TOGGLE_PORT'),
        nodeEnv,
        isProduction: nodeEnv === 'production',

        // Database - NeonDB cloud PostgreSQL
        db: (() => {
            const dbUrl = getRequired('DATABASE_URL');
            let host: string;
            let port: number;
            let name: string;
            let user: string;
            let password: string | undefined;
            let ssl = true;

            try {
                const parsedUrl = new URL(dbUrl);
                host = parsedUrl.hostname;
                port = parsedUrl.port ? parseInt(parsedUrl.port, 10) : 5432;
                name = parsedUrl.pathname.replace(/^\//, '');
                user = decodeURIComponent(parsedUrl.username);
                password = decodeURIComponent(parsedUrl.password);
                if (dbUrl.includes('sslmode=verify-full')) {
                    ssl = true;
                } else if (dbUrl.includes('sslmode=require') || dbUrl.includes('ssl=true')) {
                    // For backward compatibility, but prefer 'sslmode=verify-full'
                    ssl = true;
                }
            } catch (e) {
                logger.error('Failed to parse DATABASE_URL from environment:', e);
                throw new Error('Invalid DATABASE_URL format');
            }

            return {
                host,
                port,
                name,
                user,
                password,
                schema: getRequired('DB_SCHEMA'),
                ssl,
                connectionTimeoutMs: getInt('DB_CONNECT_TIMEOUT_MS'),
                healthTimeoutMs: getInt('DB_HEALTH_TIMEOUT_MS'),
                poolMin: getInt('DB_POOL_MIN'),
                poolMax: getInt('DB_POOL_MAX'),
                poolIdleTimeoutMs: getInt('DB_POOL_IDLE_TIMEOUT_MS'),
                keepAliveDelayMs: getInt('DB_KEEPALIVE_DELAY_MS'),
                queryTimeoutMs: getInt('DB_QUERY_TIMEOUT_MS'),
                retryAttempts: getInt('DB_RETRY_ATTEMPTS'),
                retryDelayMs: getInt('DB_RETRY_DELAY_MS'),
            };
        })(),

        // Cache
        cacheTtlSeconds: getInt('CACHE_TTL_SECONDS'),
        cacheKeyPrefix: getRequired('CACHE_KEY_PREFIX'),
        allTogglesKey: getRequired('ALL_TOGGLES_KEY'),

        // CORS
        corsOrigins: getRequired('CORS_ORIGINS').split(','),

        // Validation
        validation: {
            minNameLength: getInt('MIN_NAME_LENGTH'),
            maxNameLength: getInt('MAX_NAME_LENGTH'),
            minDescriptionLength: getInt('MIN_DESCRIPTION_LENGTH'),
            maxDescriptionLength: getInt('MAX_DESCRIPTION_LENGTH'),
        },

        // API Limits
        apiLimits: {
            defaultAuditLimit: getInt('DEFAULT_AUDIT_LIMIT'),
            maxAuditLimit: getInt('MAX_AUDIT_LIMIT'),
            defaultHistoryLimit: getInt('DEFAULT_HISTORY_LIMIT'),
            maxHistoryLimit: getInt('MAX_HISTORY_LIMIT'),
        },
    };

    return _config;
}

/**
 * Get configuration (must be loaded first)
 */
export function getConfig(): Config {
    if (!_config) {
        throw new Error('Configuration not loaded. Call loadConfig() first.');
    }
    return _config;
}

// Export singleton for convenience
export const config = {
    get: getConfig,
    load: loadConfig,
};
