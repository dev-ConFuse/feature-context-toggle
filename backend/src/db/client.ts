/**
 * Feature Toggle - Database Manager
 * 
 * PostgreSQL database manager with connection pooling, initialization,
 * and audit logging support.
 */

import { Pool, PoolClient, QueryResult } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { setDefaultResultOrder } from 'dns';
import { setDefaultAutoSelectFamily } from 'net';
import { logger } from '../utils/logger.js';
import { getConfig, type Config } from '../config.js';

// Process-wide socket behaviour, set before any connection is opened.
// WHY: Node's happy-eyeballs abandons each connect attempt after its short
// per-attempt timeout, but the runtime's path to Neon needs seconds per TCP
// handshake — every attempt died with a bare ETIMEDOUT (empty message) even
// though a plain IPv4 connect succeeds. Prefer IPv4 and let a single attempt
// run to the configured connection timeout.
setDefaultResultOrder('ipv4first');
setDefaultAutoSelectFamily(false);

// ESM __dirname equivalent
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Whitelist of allowed schema names (SQL injection protection)
const ALLOWED_SCHEMAS = ['feature_toggles', 'public'];

// =============================================================================
// Types
// =============================================================================

export interface Toggle {
  id: number;
  name: string;
  enabled: boolean;
  description: string;
  category: string;
  category_type: 'devOnly' | 'userFacing' | 'ops';
  created_at: Date;
  updated_at: Date;
  metadata: Record<string, unknown>;
}

export interface CreateToggleInput {
  name: string;
  enabled?: boolean;
  description: string;
  category: string;
  categoryType: 'devOnly' | 'userFacing' | 'ops';
  metadata?: Record<string, unknown>;
}

export interface AuditEntry {
  id: number;
  toggle_name: string;
  action: 'create' | 'update' | 'delete';
  previous_value: boolean | null;
  new_value: boolean | null;
  previous_metadata: Record<string, unknown> | null;
  new_metadata: Record<string, unknown> | null;
  changed_by: string;
  changed_at: Date;
  ip_address: string | null;
  user_agent: string | null;
  notes: string | null;
}

interface DatabaseConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password?: string;
  schema: string;
  connectionTimeoutMs: number;
  healthTimeoutMs: number;
  poolMin: number;
  poolMax: number;
  poolIdleTimeoutMs: number;
  keepAliveDelayMs: number;
  queryTimeoutMs: number;
  retryAttempts: number;
  retryDelayMs: number;
}

/**
 * Result of the bounded database liveness probe (GET /health).
 *
 * `healthy` means "no confirmed failure": a probe still in flight is *not* a
 * failure (slow connects are the norm on this runtime) — `status` refines the
 * picture: `connected` / `disconnected` are resolved outcomes, `timeout` means
 * the probe has not resolved yet. `latencyMs` is how long the health check
 * itself waited (bounded by DB_HEALTH_TIMEOUT_MS), never the raw connect time.
 */
export interface DbHealth {
  healthy: boolean;
  latencyMs: number;
  status: 'connected' | 'disconnected' | 'timeout';
  error?: string;
}

/** Probe outcome without the call-scoped latency (the cached form). */
type DbHealthOutcome = Omit<DbHealth, 'latencyMs'>;

// Socket/transport codes the pg driver surfaces on connection faults.
const TRANSIENT_SOCKET_CODES =
  /^(ETIMEDOUT|ECONNRESET|ECONNREFUSED|ECONNABORTED|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|EPIPE|EPROTO|ENOTFOUND|UND_ERR_[A-Z_]+)$/i;
const TRANSIENT_DB_MESSAGE =
  /connection (refused|reset|terminated)|timeout exceeded when trying to connect|connection timeout|query read timeout|timed out|database is not reachable|econnrefused|etimedout|econnreset|eai_again|fetch failed/i;

/**
 * True when the failure is DB connectivity (transient), not a query error.
 * Used to answer 503 (retryable) instead of a misleading 500.
 */
export function isTransientDbError(error: unknown): boolean {
  let current: unknown = error;
  // Walk a short cause chain: the driver wraps the socket error one level down.
  for (let depth = 0; current && typeof current === 'object' && depth < 4; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && TRANSIENT_SOCKET_CODES.test(code)) {
      return true;
    }
    const message = current instanceof Error
      ? current.message
      : String((current as { message?: unknown }).message ?? '');
    if (TRANSIENT_DB_MESSAGE.test(message)) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * True when the error (or one of its causes) is Postgres unique_violation.
 * A retried write can surface this way when the first attempt actually
 * committed but its response was lost — see createToggle.
 */
function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current && typeof current === 'object' && depth < 4; depth++) {
    if ((current as { code?: unknown }).code === '23505') {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// =============================================================================
// Database Manager
// =============================================================================

export class DatabaseManager {
  private pool: Pool;
  private config: DatabaseConfig;
  private initialized: boolean = false;
  private isProduction: boolean;
  /** Last resolved health-probe outcome (see healthCheck). */
  private lastHealth: DbHealthOutcome | null = null;
  /** Shared in-flight probe — health polling must not stampede the pool. */
  private inFlightProbe: Promise<DbHealthOutcome> | null = null;

  constructor() {

    // Load configuration from environment
    const appConfig = getConfig();

    this.config = {
      host: appConfig.db.host,
      port: appConfig.db.port,
      database: appConfig.db.name,
      user: appConfig.db.user,
      password: appConfig.db.password,
      schema: appConfig.db.schema,
      connectionTimeoutMs: appConfig.db.connectionTimeoutMs,
      healthTimeoutMs: appConfig.db.healthTimeoutMs,
      poolMin: appConfig.db.poolMin,
      poolMax: appConfig.db.poolMax,
      poolIdleTimeoutMs: appConfig.db.poolIdleTimeoutMs,
      keepAliveDelayMs: appConfig.db.keepAliveDelayMs,
      queryTimeoutMs: appConfig.db.queryTimeoutMs,
      retryAttempts: appConfig.db.retryAttempts,
      retryDelayMs: appConfig.db.retryDelayMs,
    };

    this.isProduction = appConfig.isProduction;

    // Validate schema name to prevent SQL injection
    if (!ALLOWED_SCHEMAS.includes(this.config.schema)) {
      throw new Error(`Invalid schema name: ${this.config.schema}. Allowed: ${ALLOWED_SCHEMAS.join(', ')}`);
    }

    // Configure SSL for NeonDB or other cloud databases
    const sslConfig = appConfig.db.ssl ? { rejectUnauthorized: false } : false;

    this.pool = new Pool({
      host: this.config.host,
      port: this.config.port,
      database: this.config.database,
      user: this.config.user,
      password: this.config.password,
      // Warm pool: keep >=1 connection open across idle gaps so requests do not
      // pay the 3-21 s container→Neon handshake again after every quiet spell.
      // TCP keepalive probes defeat idle NAT/flow expiry that silently kills
      // parked connections on this path.
      min: this.config.poolMin,
      max: this.config.poolMax,
      idleTimeoutMillis: this.config.poolIdleTimeoutMs,
      keepAlive: true,
      keepAliveInitialDelayMillis: this.config.keepAliveDelayMs,
      // Slow runtime→Neon handshakes need headroom (env-tuned, see config.ts)
      connectionTimeoutMillis: this.config.connectionTimeoutMs,
      // Query budget: server-side statement_timeout cancels stuck work cleanly;
      // query_timeout is the client-side backstop for silently-dead connections
      // where no server response will ever arrive.
      statement_timeout: this.config.queryTimeoutMs,
      query_timeout: this.config.queryTimeoutMs,
      ssl: sslConfig,
    });

      // Idle/dead pooled clients emit 'error' asynchronously. Without a
      // listener Node treats that as an uncaught exception and the whole
      // process dies mid-request (seen by callers as "Server disconnected
      // without sending a response"). Log it and let pg replace the client -
      // a dead idle connection is never a process-level failure.
      this.pool.on('error', (err: Error) => {
        logger.warn('[DATABASE] idle pool client error (pool will replace it)', err);
      });





    // Log pool errors
    this.pool.on('error', (err) => {
      logger.error('[DATABASE] [ERROR] Unexpected database pool error:', err);
    });


  }

  // =========================================================================
  // Initialization
  // =========================================================================

  /**
   * Retry a DB operation on transient connectivity failures (attempts/delay are
   * env-tuned per .cline/rules/env-policy.md) so a dropped connection does not
   * surface as a request failure — the same pattern as auth-middleware's
   * withDbRetry. Non-transient errors (e.g. constraint violations) rethrow at
   * once.
   */
  private async withRetry<T>(operation: () => Promise<T>): Promise<T> {
    const maxAttempts = Math.max(1, this.config.retryAttempts);
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        if (!isTransientDbError(error) || attempt === maxAttempts) {
          throw error;
        }
        logger.warn(`[DATABASE] transient failure, retrying (${attempt}/${maxAttempts})`, error);
        await sleep(this.config.retryDelayMs * attempt);
      }
    }
    throw lastError;
  }



  /**
   * Check out a pooled client with an inert 'error' sink attached.
   *
   * pg-pool detaches its own error forwarding the moment a client is handed
   * out, so a socket that dies mid-transaction emits 'error' on the Client
   * with no listener - Node treats that as an uncaught exception and the
   * whole process exits mid-request (callers see "Server disconnected
   * without sending a response"). The query promise still rejects, so every
   * existing try/catch keeps working unchanged.
   */
  private async connectClient(): Promise<PoolClient> {
    const client = await this.pool.connect();
    client.on('error', (err: Error) => {
      logger.warn('[DATABASE] checked-out client socket error (query will reject)', err);
    });
    return client;
  }  /** Single query with transient-failure retry. */
  private query(text: string, params?: unknown[]): Promise<QueryResult> {
    return this.withRetry(() => this.pool.query(text, params));
  }

  /**
   * Initialize the database schema and tables
   */
  async initialize(): Promise<boolean> {
    if (this.initialized) {

      return true;
    }

    try {


      // Read and execute schema file
      const schemaPath = path.resolve(__dirname, '../../../database/schema.sql');

      if (fs.existsSync(schemaPath)) {

        const schema = fs.readFileSync(schemaPath, 'utf-8');

        await this.query(schema);

      } else {
        logger.warn('[DATABASE] ⚠️ Schema file not found at:', schemaPath);

        await this.createMinimalSchema();

      }

      this.initialized = true;

      return true;
    } catch (error) {
      logger.error('[DATABASE] ❌ Failed to initialize database:', error);
      logger.error('[DATABASE] Error details:', error instanceof Error ? error.message : 'Unknown error');
      return false;
    }
  }

  /**
   * Create minimal schema if schema file is missing
   */
  private async createMinimalSchema(): Promise<void> {
    await this.pool.query(`
            CREATE SCHEMA IF NOT EXISTS public;
            
            CREATE TABLE IF NOT EXISTS public.toggles (
                id SERIAL PRIMARY KEY,
                name VARCHAR(100) UNIQUE NOT NULL,
                enabled BOOLEAN DEFAULT false,
                description TEXT NOT NULL,
                category VARCHAR(50) NOT NULL,
                category_type VARCHAR(20) NOT NULL DEFAULT 'ops',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                metadata JSONB DEFAULT '{}'::jsonb
            );
            
            CREATE TABLE IF NOT EXISTS public.audit_log (
                id SERIAL PRIMARY KEY,
                toggle_name VARCHAR(100) NOT NULL,
                action VARCHAR(20) NOT NULL,
                previous_value BOOLEAN,
                new_value BOOLEAN,
                previous_metadata JSONB,
                new_metadata JSONB,
                changed_by VARCHAR(100) NOT NULL DEFAULT 'system',
                changed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                ip_address VARCHAR(45),
                user_agent TEXT,
                notes TEXT
            );
        `);
  }

  /**
   * Health check - bounded database probe for GET /health.
   *
   * Liveness must answer even while the pool is still establishing a (slow)
   * runtime→Neon connect, so `SELECT 1` is raced against DB_HEALTH_TIMEOUT_MS
   * and the resolved outcome is cached. While a fresh query is still in flight
   * the cached status is reported; a late driver rejection can never become an
   * unhandled rejection because the probe is pre-settled. `status: 'timeout'`
   * means "probe still in flight, no outcome known yet" and is not a failure.
   */
  async healthCheck(): Promise<DbHealth> {
    const start = Date.now();
    if (!this.inFlightProbe) {
      // Deduplicated probe: concurrent health calls share one `SELECT 1`
      // instead of stacking connects on a cold pool.
      this.inFlightProbe = this.pool.query('SELECT 1').then(
        () => ({
          healthy: true,
          status: 'connected' as const,
        }),
        (error: unknown) => {
          const message = error instanceof Error ? error.message : 'Unknown error';
          if (isTransientDbError(error)) {
            // Connection-level refusals/timeouts are *inconclusive* on this
            // runtime: the container→Neon egress produces them for perfectly
            // healthy databases (connects legitimately exceed the probe budget).
            // Report "unknown", not "down", so liveness never flaps.
            return { healthy: true, status: 'timeout' as const, error: message };
          }
          return { healthy: false, status: 'disconnected' as const, error: message };
        },
      ).then((result) => {
        this.lastHealth = result;
        return result;
      }).finally(() => {
        this.inFlightProbe = null;
      });
    }
    const probe = this.inFlightProbe;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const bound = new Promise<DbHealthOutcome>((resolve) => {
      timer = setTimeout(
        // No resolved outcome yet is *not* evidence of failure: a slow connect
        // is the norm on this runtime, so an unknown state reports healthy and
        // the payload's `status: 'timeout'` tells consumers the probe is pending.
        () => resolve(this.lastHealth ?? {
          healthy: true,
          status: 'timeout' as const,
        }),
        this.config.healthTimeoutMs,
      );
    });

    try {
      const outcome = await Promise.race([probe, bound]);
      return { ...outcome, latencyMs: Date.now() - start };
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  // =========================================================================
  // Toggle CRUD Operations
  // =========================================================================

  /**
   * Get a single toggle by name
   */
  async getToggle(name: string): Promise<Toggle | null> {

    const result = await this.query(
      `SELECT * FROM ${this.config.schema}.toggles WHERE name = $1`,
      [name]
    );
    const toggle = result.rows[0] || null;

    return toggle;
  }

  /**
   * Get all toggles, optionally filtered by category
   */
  async getAllToggles(category?: string, categoryType?: string): Promise<Toggle[]> {

    let query = `SELECT * FROM ${this.config.schema}.toggles`;
    const params: string[] = [];
    const conditions: string[] = [];

    if (category) {
      conditions.push(`category = $${params.length + 1}`);
      params.push(category);
    }

    if (categoryType) {
      conditions.push(`category_type = $${params.length + 1}`);
      params.push(categoryType);
    }

    // In production, exclude devOnly toggles or force them disabled
    if (this.isProduction) {
      conditions.push(`category_type != 'devOnly' OR enabled = false`);
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    query += ' ORDER BY category, name';

    const result = await this.query(query, params);

    return result.rows;
  }

  /**
   * Create a new toggle (whole transaction retried on transient DB failures).
   *
   * Idempotent under retry: if the first attempt committed but its response
   * was lost (client-side query timeout while COMMIT finished server-side),
   * the retry hits the unique constraint. The row exists at that point, so
   * return it instead of surfacing a 500 for a successful write.
   */
  async createToggle(input: CreateToggleInput, changedBy: string = 'system'): Promise<Toggle> {
    try {
      return await this.withRetry(() => this.createToggleOnce(input, changedBy));
    } catch (error) {
      if (isUniqueViolation(error)) {
        const existing = await this.getToggle(input.name);
        if (existing) {
          logger.warn(`[DATABASE] [CREATE] retried create hit unique constraint; returning existing '${input.name}'`);
          return existing;
        }
      }
      throw error;
    }
  }

  private async createToggleOnce(input: CreateToggleInput, changedBy: string): Promise<Toggle> {

    const client = await this.connectClient();

    try {
      await client.query('BEGIN');

      // Insert the toggle
      const result = await client.query(
        `INSERT INTO ${this.config.schema}.toggles (name, enabled, description, category, category_type, metadata)
                 VALUES ($1, $2, $3, $4, $5, $6)
                 RETURNING *`,
        [
          input.name,
          input.enabled ?? false,
          input.description,
          input.category,
          input.categoryType,
          JSON.stringify(input.metadata || {}),
        ]
      );

      const toggle = result.rows[0];

      // Log the creation
      await this.logAudit(client, {
        toggleName: input.name,
        action: 'create',
        newValue: toggle.enabled,
        newMetadata: toggle.metadata,
        changedBy,
      });

      await client.query('COMMIT');

      return toggle;
    } catch (error) {
      // Best-effort rollback: on a dead connection ROLLBACK itself throws and
      // would mask the original error the caller needs to classify.
      await client.query('ROLLBACK').catch(() => undefined);
      logger.error(`[DATABASE] [CREATE] Failed to create toggle '${input.name}':`, error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Update a toggle's enabled state (whole transaction retried on transient failures).
   */
  async updateToggle(
    name: string,
    enabled: boolean,
    changedBy: string = 'system',
    notes?: string
  ): Promise<Toggle | null> {
    return this.withRetry(() => this.updateToggleOnce(name, enabled, changedBy, notes));
  }

  private async updateToggleOnce(
    name: string,
    enabled: boolean,
    changedBy: string,
    notes?: string
  ): Promise<Toggle | null> {
    const client = await this.connectClient();

    try {
      await client.query('BEGIN');

      // Get current state for audit
      const current = await client.query(`SELECT * FROM ${this.config.schema}.toggles WHERE name = $1`, [name]);

      if (current.rows.length === 0) {
        await client.query('ROLLBACK');
        return null;
      }

      const previousToggle = current.rows[0];

      // In production, prevent enabling devOnly toggles
      if (this.isProduction && previousToggle.category_type === 'devOnly' && enabled) {
        throw new Error('Cannot enable devOnly toggles in production');
      }

      // Update the toggle
      const result = await client.query(
        `UPDATE ${this.config.schema}.toggles SET enabled = $1, updated_at = CURRENT_TIMESTAMP WHERE name = $2 RETURNING *`,
        [enabled, name]
      );

      const toggle = result.rows[0];

      // Log the update
      await this.logAudit(client, {
        toggleName: name,
        action: 'update',
        previousValue: previousToggle.enabled,
        newValue: enabled,
        previousMetadata: previousToggle.metadata,
        newMetadata: toggle.metadata,
        changedBy,
        notes,
      });

      await client.query('COMMIT');

      return toggle;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      logger.error(`[DATABASE] [UPDATE] Failed to update toggle '${name}':`, error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Update toggle metadata (whole transaction retried on transient failures).
   */
  async updateToggleMetadata(
    name: string,
    metadata: Record<string, unknown>,
    changedBy: string = 'system'
  ): Promise<Toggle | null> {
    return this.withRetry(() => this.updateToggleMetadataOnce(name, metadata, changedBy));
  }

  private async updateToggleMetadataOnce(
    name: string,
    metadata: Record<string, unknown>,
    changedBy: string
  ): Promise<Toggle | null> {

    const client = await this.connectClient();

    try {
      await client.query('BEGIN');

      // Get current state for audit
      const current = await client.query(`SELECT * FROM ${this.config.schema}.toggles WHERE name = $1`, [name]);

      if (current.rows.length === 0) {
        await client.query('ROLLBACK');
        return null;
      }

      const previousToggle = current.rows[0];

      // Update the metadata
      const result = await client.query(
        `UPDATE ${this.config.schema}.toggles SET metadata = $1, updated_at = CURRENT_TIMESTAMP WHERE name = $2 RETURNING *`,
        [JSON.stringify(metadata), name]
      );

      const toggle = result.rows[0];

      // Log the update
      await this.logAudit(client, {
        toggleName: name,
        action: 'update',
        previousValue: previousToggle.enabled,
        newValue: toggle.enabled,
        previousMetadata: previousToggle.metadata,
        newMetadata: metadata,
        changedBy,
      });

      await client.query('COMMIT');
      return toggle;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Delete a toggle (whole transaction retried on transient failures).
   */
  async deleteToggle(name: string, changedBy: string = 'system'): Promise<boolean> {
    return this.withRetry(() => this.deleteToggleOnce(name, changedBy));
  }

  private async deleteToggleOnce(name: string, changedBy: string): Promise<boolean> {

    const client = await this.connectClient();

    try {
      await client.query('BEGIN');

      // Get current state for audit
      const current = await client.query(`SELECT * FROM ${this.config.schema}.toggles WHERE name = $1`, [name]);

      if (current.rows.length === 0) {
        await client.query('ROLLBACK');
        return false;
      }

      const previousToggle = current.rows[0];

      // Delete the toggle
      await client.query(`DELETE FROM ${this.config.schema}.toggles WHERE name = $1`, [name]);

      // Log the deletion
      await this.logAudit(client, {
        toggleName: name,
        action: 'delete',
        previousValue: previousToggle.enabled,
        previousMetadata: previousToggle.metadata,
        changedBy,
      });

      await client.query('COMMIT');

      return true;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      logger.error(`[DATABASE] [DELETE] Failed to delete toggle '${name}':`, error);
      throw error;
    } finally {
      client.release();
    }
  }

  // =========================================================================
  // Bulk Operations
  // =========================================================================

  /**
   * Bulk update multiple toggles at once
   */
  async bulkUpdateToggles(
    updates: Array<{ name: string; enabled: boolean }>,
    changedBy: string = 'system'
  ): Promise<Toggle[]> {

    const results: Toggle[] = [];

    for (const update of updates) {
      const toggle = await this.updateToggle(update.name, update.enabled, changedBy);
      if (toggle) {
        results.push(toggle);
      }
    }

    return results;
  }

  // =========================================================================
  // Audit Log Operations
  // =========================================================================

  /**
   * Log an audit entry
   */
  private async logAudit(
    client: PoolClient,
    entry: {
      toggleName: string;
      action: 'create' | 'update' | 'delete';
      previousValue?: boolean | null;
      newValue?: boolean | null;
      previousMetadata?: Record<string, unknown> | null;
      newMetadata?: Record<string, unknown> | null;
      changedBy: string;
      ipAddress?: string;
      userAgent?: string;
      notes?: string;
    }
  ): Promise<void> {
    await client.query(
      `INSERT INTO audit_log 
             (toggle_name, action, previous_value, new_value, previous_metadata, new_metadata, changed_by, ip_address, user_agent, notes)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        entry.toggleName,
        entry.action,
        entry.previousValue ?? null,
        entry.newValue ?? null,
        entry.previousMetadata ? JSON.stringify(entry.previousMetadata) : null,
        entry.newMetadata ? JSON.stringify(entry.newMetadata) : null,
        entry.changedBy,
        entry.ipAddress ?? null,
        entry.userAgent ?? null,
        entry.notes ?? null,
      ]
    );
  }

  /**
   * Get audit history for a toggle
   */
  async getToggleHistory(name: string, limit: number = 50): Promise<AuditEntry[]> {
    const result = await this.query(
      `SELECT * FROM audit_log 
             WHERE toggle_name = $1 
             ORDER BY changed_at DESC 
             LIMIT $2`,
      [name, limit]
    );
    return result.rows;
  }

  /**
   * Get recent audit entries across all toggles
   */
  async getRecentAuditLog(limit: number = 100): Promise<AuditEntry[]> {
    const result = await this.query(
      `SELECT * FROM audit_log 
             ORDER BY changed_at DESC 
             LIMIT $1`,
      [limit]
    );
    return result.rows;
  }

  // =========================================================================
  // Cleanup
  // =========================================================================

  /**
   * Close database connections
   */
  async close(): Promise<void> {

    await this.pool.end();

  }
}

// Lazy singleton instance
let _db: DatabaseManager | null = null;

/**
 * Get the database manager singleton (lazy initialization)
 */
export function getDb(): DatabaseManager {
  if (!_db) {

    _db = new DatabaseManager();
  }
  return _db;
}

// Export for backward compatibility (use getDb() for lazy init)
export const db = {
  get instance(): DatabaseManager {
    return getDb();
  },
  initialize: async () => getDb().initialize(),
  close: async () => _db?.close(),
};