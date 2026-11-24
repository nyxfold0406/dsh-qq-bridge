// 通用小工具：定时器与子进程。没有业务逻辑，谁都可以 import。
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
export const execFileP = promisify(execFile)
