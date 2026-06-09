'use strict';
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createLogger = createLogger;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const os_1 = __importDefault(require("os"));
// Minimal structured logger. Every proxy module gets a namespaced logger
// that prefixes each line with [HH:MM:SS] [module]. The reqId is passed
// per-call so it appears inline rather than being baked into the logger.
// --- File transport (append-only, flushed after each write) ----------------
const LOG_DIR = path_1.default.join(os_1.default.homedir(), '.deepclaude');
const LOG_FILE = path_1.default.join(LOG_DIR, 'proxy.log');
let logFd = null;
try {
    fs_1.default.mkdirSync(LOG_DIR, { recursive: true });
    logFd = fs_1.default.openSync(LOG_FILE, 'a');
}
catch {
    // File logging unavailable (e.g. read-only fs, bad path); console-only fallback.
}
function writeFile(msg) {
    if (logFd === null)
        return;
    try {
        fs_1.default.writeSync(logFd, msg + '\n');
        fs_1.default.fsyncSync(logFd);
    }
    catch {
        // Swallow file write errors so a bad disk never crashes the proxy.
    }
}
// --- Shared timestamp & format helpers -------------------------------------
function ts() {
    return new Date().toISOString().replace('T', ' ').slice(0, 19);
}
function formatLine(level, name, rid, msg) {
    return `[${ts()}] [${level}] [${name}]${rid != null ? ' [#' + rid + ']' : ''} ${msg}`;
}
function createLogger(name) {
    return {
        info(rid, msg) {
            const line = formatLine('INFO', name, rid, msg);
            console.error(line);
            writeFile(line);
        },
        warn(rid, msg) {
            const line = formatLine('WARN', name, rid, msg);
            console.error(line);
            writeFile(line);
        },
        error(rid, msg) {
            const line = formatLine('ERROR', name, rid, msg);
            console.error(line);
            writeFile(line);
        },
    };
}
