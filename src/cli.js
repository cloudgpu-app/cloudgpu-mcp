#!/usr/bin/env node
// cloudgpu 命令行入口。逻辑都在 cli-core.js 里，这里只负责把退出码交给进程。
import { run } from "./cli-core.js";

process.exitCode = await run(process.argv.slice(2));
