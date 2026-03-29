#!/usr/bin/env node
/**
 * Standalone A2A server on port 4002.
 * Runs the NanoClaw A2A host server without the full NanoClaw process
 * (which requires Docker). Use this when Docker on the host is down.
 */
import { A2AHostServer } from './dist/a2a-server.js';

const server = new A2AHostServer(4002);
server.start();

process.on('SIGTERM', () => { server.stop(); process.exit(0); });
process.on('SIGINT', () => { server.stop(); process.exit(0); });

console.log('A2A standalone server starting on port 4002...');
