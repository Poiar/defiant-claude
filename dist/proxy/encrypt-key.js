'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
// CLI helper to encrypt an API key for use in config files.
// Usage: tsx proxy/encrypt-key.ts <api-key>
// Reads DEEPCLAUDE_ENCRYPTION_KEY from environment (minimum 32 characters).
const crypto_1 = require("./crypto");
const key = process.argv[2];
if (!key) {
    console.error('Usage: tsx proxy/encrypt-key.ts <api-key>');
    process.exit(1);
}
const masterSecret = process.env.DEEPCLAUDE_ENCRYPTION_KEY;
if (!masterSecret) {
    console.error('Error: DEEPCLAUDE_ENCRYPTION_KEY environment variable is not set');
    process.exit(1);
}
if (masterSecret.length < 32) {
    console.error('Error: DEEPCLAUDE_ENCRYPTION_KEY must be at least 32 characters long');
    process.exit(1);
}
try {
    const encrypted = (0, crypto_1.encrypt)(key, masterSecret);
    console.log(encrypted);
}
catch (err) {
    console.error('Encryption failed: ' + err.message);
    process.exit(1);
}
