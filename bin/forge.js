#!/usr/bin/env node
import { main } from '../src/cli.js';
const code = await main();
if (code !== null) process.exitCode = code;
