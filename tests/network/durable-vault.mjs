// Same real custody fixture; payment goes through the staged durable SDK runner.
process.argv.push('--durable');
await import('./private-vault.mjs');
