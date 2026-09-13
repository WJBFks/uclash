#!/usr/bin/env node
import { main } from '../server/cli.js';

process.exitCode = await main();
