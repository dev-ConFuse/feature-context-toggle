/**
 * @confuse/feature-toggle-sdk - Toggle Client
 * 
 * Main client for interacting with the Feature Toggle service.
 * Includes automatic caching, retry logic, and graceful fallbacks.
 */

import pg from 'pg';

import type {
    ToggleClientConfig,
    FeatureToggle,
    ToggleState,
} from './types.js';

// =============================================================================
// Cache Entry
// =============================================================================

interface CacheEntry<T> {
    data: T;
    expiresAt: number;
}

// =============================================================================
// Toggle Client
// =============================================================================

export class ToggleClient {
    private config: Required<Omit<ToggleClientConfig, 'onServiceUnavailable' | 'databaseUrl'>> & {
        databaseUrl?: string;
        onServiceUnavailable?: (error: Error) => void;
    };
    private cache: Map<string, CacheEntry<unknown>> = new Map();
    private allTogglesCache: CacheEntry<ToggleState> | null = null;
    private pool: pg.Pool | null = null;

    constructor(config: ToggleClientConfig) {
        this.config = {
            databaseUrl: config.databaseUrl,
            cacheTtlMs: config.cacheTtlMs ?? 5000,
            timeoutMs: config.timeoutMs ?? 2000,
            retryAttempts: config.retryAttempts ?? 2,
            retryDelayMs: config.retryDelayMs ?? 500,
            serviceName: config.serviceName ?? 'unknown-service',
            defaultEnabled: config.defaultEnabled ?? false,
            onServiceUnavailable: config.onServiceUnavailable,
        };

        const dbUrl = this.config.databaseUrl || (typeof process !== 'undefined' ? process.env.DATABASE_URL : undefined);
        if (dbUrl) {
            this.pool = new pg.Pool({
                connectionString: dbUrl,
                // Short timeout for connections to avoid hanging
                connectionTimeoutMillis: this.config.timeoutMs,
                // Don't keep too many idle connections open for a simple feature toggle SDK
                max: 5,
            });
            
            // Prevent unhandled rejections on idle connection errors
            this.pool.on('error', (err) => {
                console.warn(`[FeatureToggle] Unexpected database pool error: ${err.message}`);
            });
        } else {
            console.warn('[FeatureToggle] No DATABASE_URL provided. Feature toggle SDK will use default values.');
        }
    }

    // =========================================================================
    // Core Methods
    // =========================================================================

    /**
     * Check if a toggle is enabled
     */
    async isEnabled(toggleName: string): Promise<boolean> {
        const toggle = await this.getToggle(toggleName);
        return toggle?.enabled ?? this.config.defaultEnabled;
    }

    /**
     * Get a specific toggle by name
     */
    async getToggle(toggleName: string): Promise<FeatureToggle | null> {
        const cacheKey = `toggle:${toggleName}`;
        const cached = this.getCached<FeatureToggle>(cacheKey);
        if (cached !== null) {
            return cached;
        }

        if (!this.pool) {
            return this.fallbackToStaleCache(cacheKey);
        }

        try {
            const result = await this.pool.query(
                'SELECT name, enabled, description, category, category_type as "categoryType", metadata FROM public.toggles WHERE name = $1',
                [toggleName]
            );

            if (result.rows.length > 0) {
                const toggle = result.rows[0] as FeatureToggle;
                this.setCache(cacheKey, toggle);
                return toggle;
            }
            return null;
        } catch (error) {
            this.handleError(error as Error);
            return this.fallbackToStaleCache(cacheKey);
        }
    }

    /**
     * Get all toggles
     */
    async getAllToggles(): Promise<ToggleState> {
        if (this.allTogglesCache && Date.now() < this.allTogglesCache.expiresAt) {
            return this.allTogglesCache.data;
        }

        if (!this.pool) {
            if (this.allTogglesCache) {
                console.warn(`[FeatureToggle] Using stale cache for all toggles`);
                return this.allTogglesCache.data;
            }
            return {};
        }

        try {
            const result = await this.pool.query(
                'SELECT name, enabled, description, category, category_type as "categoryType", metadata FROM public.toggles'
            );

            const state: ToggleState = {};
            for (const row of result.rows) {
                const { name, ...rest } = row;
                state[name] = rest as Omit<FeatureToggle, 'name'>;
            }

            this.allTogglesCache = {
                data: state,
                expiresAt: Date.now() + this.config.cacheTtlMs,
            };
            
            return state;
        } catch (error) {
            this.handleError(error as Error);
            if (this.allTogglesCache) {
                console.warn(`[FeatureToggle] Using stale cache for all toggles`);
                return this.allTogglesCache.data;
            }
            return {};
        }
    }

    /**
     * Get toggles by category
     */
    async getTogglesByCategory(category: string): Promise<ToggleState> {
        const cacheKey = `category:${category}`;
        const cached = this.getCached<ToggleState>(cacheKey);
        if (cached !== null) {
            return cached;
        }

        if (!this.pool) {
            return this.fallbackToStaleCache(cacheKey) || {};
        }

        try {
            const result = await this.pool.query(
                'SELECT name, enabled, description, category, category_type as "categoryType", metadata FROM public.toggles WHERE category = $1',
                [category]
            );

            const state: ToggleState = {};
            for (const row of result.rows) {
                const { name, ...rest } = row;
                state[name] = rest as Omit<FeatureToggle, 'name'>;
            }

            this.setCache(cacheKey, state);
            return state;
        } catch (error) {
            this.handleError(error as Error);
            return this.fallbackToStaleCache(cacheKey) || {};
        }
    }

    /**
     * Check multiple toggles at once
     */
    async areEnabled(toggleNames: string[]): Promise<Record<string, boolean>> {
        const result: Record<string, boolean> = {};
        const toggles = await this.getAllToggles();

        for (const name of toggleNames) {
            result[name] = toggles[name]?.enabled ?? this.config.defaultEnabled;
        }

        return result;
    }

    // =========================================================================
    // Cache Management
    // =========================================================================

    /**
     * Invalidate all cached data
     */
    invalidateCache(): void {
        this.cache.clear();
        this.allTogglesCache = null;
    }

    /**
     * Invalidate a specific toggle's cache
     */
    invalidateToggle(toggleName: string): void {
        this.cache.delete(`toggle:${toggleName}`);
        this.allTogglesCache = null;
    }

    /**
     * Close the database pool cleanly
     */
    async close(): Promise<void> {
        if (this.pool) {
            await this.pool.end();
            this.pool = null;
        }
    }

    // =========================================================================
    // Private Methods
    // =========================================================================

    private getCached<T>(key: string): T | null {
        const entry = this.cache.get(key) as CacheEntry<T> | undefined;
        if (entry && Date.now() < entry.expiresAt) {
            return entry.data;
        }
        return null;
    }

    private fallbackToStaleCache<T>(key: string): T | null {
        const entry = this.cache.get(key) as CacheEntry<T> | undefined;
        if (entry) {
            console.warn(`[FeatureToggle] Using stale cache for: ${key}`);
            return entry.data;
        }
        return null;
    }

    private setCache<T>(key: string, data: T): void {
        this.cache.set(key, {
            data,
            expiresAt: Date.now() + this.config.cacheTtlMs,
        });
    }

    private handleError(error: Error): void {
        console.warn(`[FeatureToggle] Database connection issue: ${error.message}`);
        if (this.config.onServiceUnavailable) {
            this.config.onServiceUnavailable(error);
        }
    }
}

// =============================================================================
// Factory Function
// =============================================================================

export function createToggleClient(config: ToggleClientConfig = {}): ToggleClient {
    return new ToggleClient(config);
}

// =============================================================================
// Singleton Pattern
// =============================================================================

let defaultClient: ToggleClient | null = null;

export function initToggleClient(config: ToggleClientConfig = {}): ToggleClient {
    if (defaultClient) {
        defaultClient.close().catch(console.error);
    }
    defaultClient = new ToggleClient(config);
    return defaultClient;
}

export function getToggleClient(): ToggleClient {
    if (!defaultClient) {
        // Auto-initialize if not done explicitly, using env variables
        defaultClient = new ToggleClient({});
    }
    return defaultClient;
}

export async function isToggleEnabled(toggleName: string): Promise<boolean> {
    return getToggleClient().isEnabled(toggleName);
}
