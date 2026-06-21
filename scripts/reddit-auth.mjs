#!/usr/bin/env node

/**
 * reddit-auth.mjs — Fetch Reddit post content via authenticated JSON API
 *
 * Uses Playwright to log into Reddit and fetch .json from within a browser
 * context, bypassing Reddit's network-level 403 on anonymous .json access.
 *
 * Usage:
 *   node scripts/reddit-auth.mjs --url <reddit-post-url>
 *   node scripts/reddit-auth.mjs --url <url> --pretty
 *   node scripts/reddit-auth.mjs --url <url> --comments 10
 *
 * Environment variables (optional — prompts if missing):
 *   REDDIT_AUTH=username:password    (e.g. myuser:mypassword)
 *   REDDIT_HEADLESS=true             (run headless, default false)
 *
 * Why this exists:
 *   Reddit's .json endpoint returns 403 from curl/HTTP clients even with
 *   valid session cookies. It only works when requested from within a
 *   logged-in browser session (same-origin context). This script bridges
 *   that gap by driving a real browser via Playwright.
 */

import { chromium } from 'playwright';
import { readFileSync, existsSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

// --- Config ---
const REDDIT_AUTH_FILE = join(homedir(), '.reddit-auth');
const DEFIANT_AUTH_FILE = join(homedir(), '.defiant', 'reddit-auth.json');

function getCredentials() {
  // 1. Check env var REDDIT_AUTH=username:password
  const env = process.env.REDDIT_AUTH;
  if (env && env.includes(':')) {
    const [username, ...rest] = env.split(':');
    return { username: username.trim(), password: rest.join(':') };
  }
  // 2. Check .reddit-auth file (username:password on first line)
  if (existsSync(REDDIT_AUTH_FILE)) {
    const line = readFileSync(REDDIT_AUTH_FILE, 'utf-8').split('\n')[0].trim();
    if (line && line.includes(':')) {
      const [username, ...rest] = line.split(':');
      return { username: username.trim(), password: rest.join(':') };
    }
  }
  // 3. Check ~/.defiant/reddit-auth.json (set via admin interface)
  if (existsSync(DEFIANT_AUTH_FILE)) {
    try {
      const data = JSON.parse(readFileSync(DEFIANT_AUTH_FILE, 'utf-8'));
      if (data.username && data.password) {
        return { username: data.username, password: data.password };
      }
    } catch (_e) { /* ignore parse errors */ }
  }
  return null;
}

function toJsonUrl(url) {
  url = url.replace(/\/$/, '').replace('old.reddit.com', 'www.reddit.com');
  // If already a .json URL, return as-is
  if (url.endsWith('.json')) return url;
  const match = url.match(/\/r\/([^/]+)\/comments\/([^/]+)/);
  if (!match) return null;
  return `https://www.reddit.com/r/${match[1]}/comments/${match[2]}/.json`;
}

function extractPost(json, opts = {}) {
  const post = json[0]?.data?.children?.[0]?.data;
  if (!post) return null;

  const maxComments = opts.comments || 5;
  const comments = [];
  const listing = json[1]?.data?.children || [];
  for (const child of listing) {
    if (child.kind === 't1' && child.data) {
      comments.push({
        author: child.data.author,
        score: child.data.score,
        body: child.data.body?.substring(0, opts.maxCommentLen || 500) || '',
        depth: child.data.depth || 0,
        replies: child.data.replies
          ? Array.isArray(child.data.replies?.data?.children)
            ? child.data.replies.data.children
                .filter((r) => r.data?.body)
                .map((r) => ({
                  author: r.data.author,
                  score: r.data.score,
                  body: r.data.body.substring(0, opts.maxCommentLen || 500),
                }))
            : []
          : [],
      });
      if (comments.length >= maxComments) break;
    }
  }

  return {
    title: post.title,
    author: post.author,
    score: post.score,
    upvoteRatio: post.upvote_ratio,
    numComments: post.num_comments,
    subreddit: post.subreddit,
    url: `https://www.reddit.com${post.permalink}`,
    created: new Date(post.created_utc * 1000).toISOString(),
    body: post.selftext || '',
    comments,
    modhash: post.modhash,
    raw: opts.raw ? post : undefined,
  };
}

// --- Main ---
async function main() {
  const args = process.argv.slice(2);
  let url = null;
  let pretty = false;
  let comments = 5;
  let raw = false;

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--url' || args[i] === '--post') && i + 1 < args.length) {
      url = args[++i];
    } else if (args[i] === '--pretty') {
      pretty = true;
    } else if (args[i] === '--comments' && i + 1 < args.length) {
      comments = parseInt(args[++i], 10) || 5;
    } else if (args[i] === '--raw') {
      raw = true;
    }
  }

  if (!url) {
    console.error('Usage: node scripts/reddit-auth.mjs --url <reddit-post-url> [--pretty] [--comments N] [--raw]');
    console.error('       REDDIT_AUTH=username:password node scripts/reddit-auth.mjs --url <url>');
    process.exit(1);
  }

  const jsonUrl = toJsonUrl(url);
  if (!jsonUrl) {
    console.error('Error: Invalid Reddit post URL');
    process.exit(1);
  }

  const creds = getCredentials();
  if (!creds) {
    console.error('Error: No Reddit credentials found.');
    console.error('  Set REDDIT_AUTH=username:password or create ~/.reddit-auth');
    process.exit(1);
  }

  console.error(`Logging in as ${creds.username}...`);
  const browser = await chromium.launch({
    headless: process.env.REDDIT_HEADLESS !== 'false',
  });

  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
    });
    const page = await context.newPage();

    // Go to login page
    await page.goto('https://www.reddit.com/login/', { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);

    // Fill login form
    const inputs = await page.locator('input:not([type="hidden"])').all();
    if (inputs.length < 2) {
      throw new Error('Could not find login form inputs');
    }
    await inputs[0].fill(creds.username);
    await inputs[1].fill(creds.password);

    // Click login button
    await page.locator('button:has-text("Log In")').click();
    await page.waitForTimeout(5000);

    // Navigate to .json URL
    console.error(`Fetching ${jsonUrl}...`);
    const response = await page.goto(jsonUrl, { waitUntil: 'domcontentloaded' });

    if (response.status() !== 200) {
      throw new Error(`HTTP ${response.status()} — login may have failed`);
    }

    // Parse JSON from the page body
    const json = JSON.parse(await page.evaluate(() => document.body.innerText));

    const post = extractPost(json, { comments, raw });
    if (!post) {
      throw new Error('Could not parse post data from response');
    }

    if (pretty) {
      console.log(JSON.stringify(post, null, 2));
    } else {
      console.log('');
      console.log(post.title);
      console.log('by ' + post.author + ' · r/' + post.subreddit);
      console.log('Score: ' + post.score + ' (' + Math.round(post.upvoteRatio * 100) + '% upvoted) · '
        + post.numComments + ' comments');
      console.log('Created: ' + post.created);
      console.log('');
      console.log(post.body.substring(0, 2000));
      console.log('');
      if (post.comments.length > 0) {
        console.log('─'.repeat(40));
        console.log('Top comments (score: body):');
        console.log('');
        post.comments.forEach((c, i) => {
          console.log('  #' + (i + 1) + ' (+' + c.score + ') ' + c.author + ': ' + c.body.substring(0, 300));
          if (c.replies.length > 0) {
            c.replies.slice(0, 2).forEach((r) => {
              console.log('    ↳ +' + r.score + ' ' + r.author + ': ' + r.body.substring(0, 200));
            });
          }
          console.log('');
        });
      }
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
