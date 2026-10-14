/**
 * Feature Toggle - Database Manager
 * 
 * PostgreSQL database manager with connection pooling, initialization,
 * and audit logging support.
 */

import { Pool, PoolClient } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../utils/logger.js';
import { getConfig, type Config } from '../config.js';

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
}

// =============================================================================
// Database Manager
// =============================================================================

export class DatabaseManager {
  private pool: Pool;
  private config: DatabaseConfig;
  private initialized: boolean = false;
  private isProduction: boolean;

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
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
      ssl: sslConfig,
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

        await this.pool.query(schema);

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
   * Health check - verify database connectivity
   */
  async healthCheck(): Promise<{ healthy: boolean; latencyMs: number; error?: string }> {

    const start = Date.now();
    try {
      await this.pool.query('SELECT 1');
      const latency = Date.now() - start;

      return {
        healthy: true,
        latencyMs: latency,
      };
    } catch (error) {
      const latency = Date.now() - start;
      logger.error(`[DATABASE] [HEALTH] Health check failed, latency: ${latency}ms`, error);
      return {
        healthy: false,
        latencyMs: latency,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  // =========================================================================
  // Toggle CRUD Operations
  // =========================================================================

  /**
   * Get a single toggle by name
   */
  async getToggle(name: string): Promise<Toggle | null> {

    const result = await this.pool.query(
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

    const result = await this.pool.query(query, params);

    return result.rows;
  }

  /**
   * Create a new toggle
   */
  async createToggle(input: CreateToggleInput, changedBy: string = 'system'): Promise<Toggle> {

    const client = await this.pool.connect();

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
      await client.query('ROLLBACK');
      logger.error(`[DATABASE] [CREATE] Failed to create toggle '${input.name}':`, error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Update a toggle's enabled state
   */
  async updateToggle(
    name: string,
    enabled: boolean,
    changedBy: string = 'system',
    notes?: string
  ): Promise<Toggle | null> {
    const client = await this.pool.connect();

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
      await client.query('ROLLBACK');
      logger.error(`[DATABASE] [UPDATE] Failed to update toggle '${name}':`, error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Update toggle metadata
   */
  async updateToggleMetadata(
    name: string,
    metadata: Record<string, unknown>,
    changedBy: string = 'system'
  ): Promise<Toggle | null> {

    const client = await this.pool.connect();

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
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Delete a toggle
   */
  async deleteToggle(name: string, changedBy: string = 'system'): Promise<boolean> {

    const client = await this.pool.connect();

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
      await client.query('ROLLBACK');
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
    const result = await this.pool.query(
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
    const result = await this.pool.query(
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