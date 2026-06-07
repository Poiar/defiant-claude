'use strict';

// Minimal structured logger. Every proxy module gets a namespaced logger
// that prefixes each line with [HH:MM:SS] [module]. The reqId is passed
// per-call so it appears inline rather than being baked into the logger.

function ts(): string {
    return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

interface Logger {
    info(rid: string | number | null | undefined, msg: string): void;
    warn(rid: string | number | null | undefined, msg: string): void;
    error(rid: string | number | null | undefined, msg: string): void;
}

export function createLogger(name: string): Logger {
    return {
        info(rid: string | number | null | undefined, msg: string): void {
            console.error(`[${ts()}] [INFO] [${name}]${rid != null ? ' [#' + rid + ']' : ''} ${msg}`);
        },
        warn(rid: string | number | null | undefined, msg: string): void {
            console.error(`[${ts()}] [WARN] [${name}]${rid != null ? ' [#' + rid + ']' : ''} ${msg}`);
        },
        error(rid: string | number | null | undefined, msg: string): void {
            console.error(`[${ts()}] [ERROR] [${name}]${rid != null ? ' [#' + rid + ']' : ''} ${msg}`);
        },
    };
}

