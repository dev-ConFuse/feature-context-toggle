import winston from 'winston';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

// Load env files before reading LOG_LEVEL / LOG_FORMAT (env-policy: .map.env →
// .secret.env → .env.local; required vars fail fast, never silently defaulted).
// Both cwd and the service root are probed — index.ts resolves env from either.
const here = path.dirname(fileURLToPath(import.meta.url));
const envDirCandidates = [process.cwd(), path.resolve(here, '..', '..', '..')];
for (const dir of envDirCandidates) {
    dotenv.config({ path: path.resolve(dir, '.map.env') });
    dotenv.config({ path: path.resolve(dir, '.secret.env'), override: true });
    dotenv.config({ path: path.resolve(dir, '.env.local'), override: true });
}

const logLevel = process.env.LOG_LEVEL;
if (!logLevel) {
    throw new Error('Missing required environment variable: LOG_LEVEL');
}
const logFormat = process.env.LOG_FORMAT;
if (!logFormat) {
    throw new Error('Missing required environment variable: LOG_FORMAT');
}

// Ensure logs directory exists
const logDir = 'logs';
if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir);
}

const levels = {
    error: 0,
    warn: 1,
    info: 2,
    http: 3,
    debug: 4,
};

const colors = {
    error: 'red',
    warn: 'yellow',
    info: 'green',
    http: 'magenta',
    debug: 'white',
};

winston.addColors(colors);

/** Include structured metadata in the human-readable output (never dropped). */
const withMeta = winston.format.printf((info: any) => {
    const { timestamp, level, message, ...meta } = info;
    const metaStr = Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
    return `${timestamp} ${level}: ${message}${metaStr}`;
});

const format = logFormat === 'json'
    ? winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss:ms' }),
        winston.format.json()
    )
    : winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss:ms' }),
        winston.format.colorize({ all: true }),
        withMeta
    );

const transports = [
    new winston.transports.Console({
        format, // structured metadata included on every line
    })
];

export const logger = winston.createLogger({
    level: logLevel,
    levels,
    transports,
});
