#!/usr/bin/env node

import { spawn } from 'node:child_process';

const splitAt = process.argv.indexOf('--');

if (splitAt < 3 || splitAt === process.argv.length - 1) {
  console.error('Usage: node scripts/run-with-env.mjs KEY=value [KEY=value ...] -- command [args ...]');
  process.exit(1);
}

const envPairs = process.argv.slice(2, splitAt);
const command = process.argv[splitAt + 1];
const args = process.argv.slice(splitAt + 2);
const env = { ...process.env };

for (const pair of envPairs) {
  const eq = pair.indexOf('=');
  if (eq <= 0) {
    console.error(`Invalid environment assignment: ${pair}`);
    process.exit(1);
  }
  env[pair.slice(0, eq)] = pair.slice(eq + 1);
}

const child = spawn(command, args, {
  env,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`Command terminated by signal ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 0);
});

child.on('error', (err) => {
  console.error(err.message);
  process.exit(1);
});
