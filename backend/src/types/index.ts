/**
 * Feature Toggle - Type Definitions
 */

// =============================================================================
// Core Types
// =============================================================================

export type CategoryType = 'devOnly' | 'userFacing' | 'ops';

export interface FeatureToggle {
    enabled: boolean;
    description: string;
    category: string;
    categoryType?: CategoryType;
    [key: string]: unknown;
}

export interface ToggleState {
    [key: string]: FeatureToggle;
}

// =============================================================================
// Database Types
// =============================================================================

export interface DbToggle {
    id: number;
    name: string;
    enabled: boolean;
    description: string;
    category: string;
    category_type: CategoryType;
    created_at: Date;
    updated_at: Date;
    metadata: Record<string, unknown>;
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

// =============================================================================
// API Request Types
// =============================================================================

export interface ToggleUpdateRequest {
    enabled: boolean;
}

export interface ToggleCreateRequest {
    name: string;
    enabled?: boolean;
    description: string;
    category: string;
    categoryType: CategoryType;
    metadata?: Record<string, unknown>;
}

export interface ToggleMetadataUpdateRequest {
    metadata: Record<string, unknown>;
}

export interface BulkUpdateRequest {
    toggles: Array<{
        name: string;
        enabled: boolean;
    }>;
}

// =============================================================================
// API Response Types
// =============================================================================

export interface ApiResponse<T = unknown> {
    success: boolean;
    data?: T;
    error?: string;
    errors?: string[];
    timestamp: string;
}

export interface HealthResponse {
    status: 'healthy' | 'degraded' | 'unhealthy';
    service: string;
    version: string;
    timestamp: string;
    dependencies: {
        database: {
            healthy: boolean;
            latencyMs: number;
            /** Resolved probe outcome; `timeout` = probe still in flight. */
            status?: 'connected' | 'disconnected' | 'timeout';
            error?: string;
        };
        cache: {
            healthy: boolean;
            latencyMs: number;
        };
    };
}

export interface PaginatedResponse<T> {
    data: T[];
    total: number;
    page: number;
    pageSize: number;
    hasMore: boolean;
}
