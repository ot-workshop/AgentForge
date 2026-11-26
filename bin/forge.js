#!/usr/bin/env node
import { main } from '../src/cli.js';
const code = main();
if (code !== null) process.exitCode = code;
