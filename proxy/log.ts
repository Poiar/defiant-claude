'use strict';

import fs from 'fs';
import path from 'path';
import os from 'os';

// Minimal structured logger. Every proxy module gets a namespaced logger
// that prefixes each line with [HH:MM:SS] [module]. The reqId is passed
// per-call so it appears inline rather than being baked into the logger.

// --- File transport (append-only, flushed after each write) ----------------

const LOG_DIR = path.join(os.homedir(), '.deepclaude');
const LOG_FILE = path.join(LOG_DIR, 'proxy.log');

let logFd: number | null = null;
try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    logFd = fs.openSync(LOG_FILE, 'a');
} catch {
    // File logging unavailable (e.g. read-only fs, bad path); console-only fallback.
}

let lastFsync = 0;
function writeFile(msg: string): void {
    if (logFd === null) return;
    try {
        fs.writeSync(logFd, msg + '\n');
        // Throttle fsync to once per second to avoid blocking the event loop
        // on every log line under high throughput.
        const now = Date.now();
        if (now - lastFsync >= 1000) {
            fs.fsyncSync(logFd);
            lastFsync = now;
        }
    } catch {
        // Swallow file write errors so a bad disk never crashes the proxy.
    }
}

// --- Shared timestamp & format helpers -------------------------------------

function ts(): string {
    return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function formatLine(
    level: string,
    name: string,
    rid: string | number | null | undefined,
    msg: string,
): string {
    return `[${ts()}] [${level}] [${name}]${rid != null ? ' [#' + rid + ']' : ''} ${msg}`;
}

// --- Debug gating ----------------------------------------------------------

const DEBUG_ENABLED: boolean =
    ['true', '1', 'yes'].includes((process.env.DEEPCLAUDE_DEBUG || '').toLowerCase()) ||
    ['true', '1', 'yes', 'debug'].includes((process.env.DEEPCLAUDE_LOG_LEVEL || '').toLowerCase());

// --- Public interface ------------------------------------------------------

interface Logger {
    debug(rid: string | number | null | undefined, msg: string): void;
    info(rid: string | number | null | undefined, msg: string): void;
    warn(rid: string | number | null | undefined, msg: string): void;
    error(rid: string | number | null | undefined, msg: string): void;
}

export function createLogger(name: string): Logger {
    const impl: Logger = {
        debug(rid: string | number | null | undefined, msg: string): void {
            if (!DEBUG_ENABLED) return;
            const line = formatLine('DEBUG', name, rid, msg);
            console.error(line);
            writeFile(line);
        },
        info(rid: string | number | null | undefined, msg: string): void {
            const line = formatLine('INFO', name, rid, msg);
            console.error(line);
            writeFile(line);
        },
        warn(rid: string | number | null | undefined, msg: string): void {
            const line = formatLine('WARN', name, rid, msg);
            console.error(line);
            writeFile(line);
        },
        error(rid: string | number | null | undefined, msg: string): void {
            const line = formatLine('ERROR', name, rid, msg);
            console.error(line);
            writeFile(line);
        },
    };
    return impl;
}

