/**
 * Feature Toggle - Validation Module
 * 
 * Validates toggle inputs and enforces naming conventions.
 */

import { getConfig } from './config.js';
import { logger } from './utils/logger.js';

// =============================================================================
// Types
// =============================================================================

export interface ValidationResult {
    valid: boolean;
    errors: string[];
}

export interface CreateToggleInput {
    name: string;
    enabled?: boolean;
    description: string;
    category: string;
    categoryType: 'devOnly' | 'userFacing' | 'ops';
    metadata?: Record<string, unknown>;
}

// =============================================================================
// Validation Rules
// =============================================================================

const VALID_CATEGORY_TYPES = ['devOnly', 'userFacing', 'ops'] as const;
const VALID_CATEGORIES = [
    'authentication',
    'data',
    'infrastructure',
    'debugging',
    'observability',
    'performance',
    'security',
    'user-experience',
] as const;

// camelCase pattern: starts with lowercase, followed by alphanumeric
const CAMEL_CASE_PATTERN = /^[a-z][a-zA-Z0-9]*$/;

// Get validation config (lazy-loaded to allow config initialization)
function getValidationConfig() {
    const config = getConfig();
    return config.validation;
}

// =============================================================================
// Validation Functions
// =============================================================================

/**
 * Validate toggle name
 */
export function validateToggleName(name: string): ValidationResult {
    const errors: string[] = [];
    const { minNameLength, maxNameLength } = getValidationConfig();

    if (!name || typeof name !== 'string') {
        errors.push('Toggle name is required');
        return { valid: false, errors };
    }

    if (name.length < minNameLength) {
        errors.push(`Toggle name must be at least ${minNameLength} characters`);
    }

    if (name.length > maxNameLength) {
        errors.push(`Toggle name must be at most ${maxNameLength} characters`);
    }

    if (!CAMEL_CASE_PATTERN.test(name)) {
        errors.push('Toggle name must be camelCase (start with lowercase, alphanumeric only)');
    }

    return { valid: errors.length === 0, errors };
}

/**
 * Validate toggle description
 */
export function validateDescription(description: string): ValidationResult {
    const errors: string[] = [];
    const { minDescriptionLength, maxDescriptionLength } = getValidationConfig();

    if (!description || typeof description !== 'string') {
        errors.push('Toggle description is required');
        return { valid: false, errors };
    }

    if (description.length < minDescriptionLength) {
        errors.push(`Description must be at least ${minDescriptionLength} characters`);
    }

    if (description.length > maxDescriptionLength) {
        errors.push(`Description must be at most ${maxDescriptionLength} characters`);
    }

    return { valid: errors.length === 0, errors };
}

/**
 * Validate category type
 */
export function validateCategoryType(categoryType: string): ValidationResult {
    const errors: string[] = [];

    if (!categoryType) {
        errors.push('Category type is required');
        return { valid: false, errors };
    }

    if (!VALID_CATEGORY_TYPES.includes(categoryType as typeof VALID_CATEGORY_TYPES[number])) {
        errors.push(`Category type must be one of: ${VALID_CATEGORY_TYPES.join(', ')}`);
    }

    return { valid: errors.length === 0, errors };
}

/**
 * Validate category
 */
export function validateCategory(category: string): ValidationResult {
    const errors: string[] = [];

    if (!category || typeof category !== 'string') {
        errors.push('Category is required');
        return { valid: false, errors };
    }

    // Allow custom categories, but warn if not in standard list
    if (!VALID_CATEGORIES.includes(category as typeof VALID_CATEGORIES[number])) {
        // This is a warning, not an error - allow custom categories
        logger.info(`Note: Using custom category '${category}'. Standard categories are: ${VALID_CATEGORIES.join(', ')}`);
    }

    return { valid: errors.length === 0, errors };
}

/**
 * Validate complete toggle creation input
 */
export function validateCreateToggle(input: unknown): ValidationResult {
    const errors: string[] = [];

    if (!input || typeof input !== 'object') {
        return { valid: false, errors: ['Request body must be an object'] };
    }

    const data = input as Record<string, unknown>;

    // Name validation
    const nameResult = validateToggleName(data.name as string);
    errors.push(...nameResult.errors);

    // Description validation
    const descResult = validateDescription(data.description as string);
    errors.push(...descResult.errors);

    // Category type validation
    const categoryTypeResult = validateCategoryType(data.categoryType as string);
    errors.push(...categoryTypeResult.errors);

    // Category validation
    const categoryResult = validateCategory(data.category as string);
    errors.push(...categoryResult.errors);

    // Enabled must be boolean if provided
    if (data.enabled !== undefined && typeof data.enabled !== 'boolean') {
        errors.push('enabled must be a boolean');
    }

    // Metadata must be object if provided
    if (data.metadata !== undefined && (typeof data.metadata !== 'object' || Array.isArray(data.metadata))) {
        errors.push('metadata must be an object');
    }

    return { valid: errors.length === 0, errors };
}

/**
 * Validate toggle update input
 */
export function validateUpdateToggle(input: unknown): ValidationResult {
    const errors: string[] = [];

    if (!input || typeof input !== 'object') {
        return { valid: false, errors: ['Request body must be an object'] };
    }

    const data = input as Record<string, unknown>;

    if (typeof data.enabled !== 'boolean') {
        errors.push('enabled must be a boolean');
    }

    return { valid: errors.length === 0, errors };
}

/**
 * Validate metadata update input
 */
export function validateMetadataUpdate(input: unknown): ValidationResult {
    const errors: string[] = [];

    if (!input || typeof input !== 'object') {
        return { valid: false, errors: ['Request body must be an object'] };
    }

    const data = input as Record<string, unknown>;

    if (!data.metadata || typeof data.metadata !== 'object' || Array.isArray(data.metadata)) {
        errors.push('metadata must be an object');
    }

    return { valid: errors.length === 0, errors };
}

/**
 * Validate bulk update input
 */
export function validateBulkUpdate(input: unknown): ValidationResult {
    const errors: string[] = [];

    if (!input || typeof input !== 'object') {
        return { valid: false, errors: ['Request body must be an object'] };
    }

    const data = input as Record<string, unknown>;

    if (!Array.isArray(data.toggles)) {
        errors.push('toggles must be an array');
        return { valid: false, errors };
    }

    for (let i = 0; i < data.toggles.length; i++) {
        const toggle = data.toggles[i] as Record<string, unknown>;

        if (!toggle.name || typeof toggle.name !== 'string') {
            errors.push(`toggles[${i}].name must be a string`);
        }

        if (typeof toggle.enabled !== 'boolean') {
            errors.push(`toggles[${i}].enabled must be a boolean`);
        }
    }

    return { valid: errors.length === 0, errors };
}
