'use strict';

// CLI helper to encrypt an API key for use in config files.
// Usage: tsx proxy/encrypt-key.ts <api-key>
//        tsx proxy/encrypt-key.ts  (prompts via stdin)
// Reads DEEPCLAUDE_ENCRYPTION_KEY from environment.
//
// Note: Passing the key as a command-line argument exposes it in the
// process list (visible to other users via ps aux on shared systems).
// The stdin prompt is the secure alternative.

import { encrypt } from './crypto';
import * as readline from 'readline';

async function main(): Promise<void> {
    let key: string;
    if (process.argv[2]) {
        key = process.argv[2];
        console.warn('Warning: passing the key as a command-line argument exposes it in the process list. Consider using stdin instead.');
    } else {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        key = await new Promise<string>((resolve) => {
            rl.question('Enter API key to encrypt: ', (answer: string) => {
                rl.close();
                resolve(answer.trim());
            });
        });
    }

    if (!key) {
        console.error('Error: No API key provided');
        process.exit(1);
    }

    const masterSecret = process.env.DEEPCLAUDE_ENCRYPTION_KEY;

    if (!masterSecret) {
        console.error('Error: DEEPCLAUDE_ENCRYPTION_KEY environment variable is not set');
        process.exit(1);
    }

    // scrypt stretches any-length key into a 256-bit derived key, so the 32-char
    // minimum is not a cryptographic requirement. We warn on short keys but
    // do not reject them.
    if (masterSecret.length < 32) {
        console.warn('Warning: DEEPCLAUDE_ENCRYPTION_KEY is shorter than 32 characters. This is acceptable (scrypt stretches it), but a longer key is recommended.');
    }

    try {
        const encrypted = await encrypt(key, masterSecret);
        console.log(encrypted);
    } catch (err) {
        console.error('Encryption failed: ' + (err as Error).message);
        process.exit(1);
    }
}

main().catch((err) => {
    console.error('Unexpected error: ' + (err as Error).message);
    process.exit(1);
});
