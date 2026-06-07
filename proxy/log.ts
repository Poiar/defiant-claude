'use strict';

// Minimal structured logger. Every proxy module gets a namespaced logger
// that prefixes each line with [HH:MM:SS] [module]. The reqId is passed
// per-call so it appears inline rather than being baked into the logger.

function ts(): string {
    return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

interface Logger {
    info(rid: string | null | undefined, msg: string): void;
    warn(rid: string | null | undefined, msg: string): void;
    error(rid: string | null | undefined, msg: string): void;
}

export function createLogger(name: string): Logger {
    return {
        info(rid: string | null | undefined, msg: string): void {
            console.error(`[${ts()}] [INFO] [${name}]${rid ? ' [#' + rid + ']' : ''} ${msg}`);
        },
        warn(rid: string | null | undefined, msg: string): void {
            console.error(`[${ts()}] [WARN] [${name}]${rid ? ' [#' + rid + ']' : ''} ${msg}`);
        },
        error(rid: string | null | undefined, msg: string): void {
            console.error(`[${ts()}] [ERROR] [${name}]${rid ? ' [#' + rid + ']' : ''} ${msg}`);
        },
    };
}

