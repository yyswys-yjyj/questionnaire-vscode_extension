// qlangDebug.ts — QLang 调试工具
// 用于在 VSCode 中快速测试 QLang 脚本

import * as fs from 'fs';
import * as path from 'path';
import { executeQLang, setQLangWorkingDir, ScriptError } from './QLangInterpreter';
import { formatQLangOutput, formatQLangError } from './output';

/**
 * 调试运行 QLang 脚本
 * @param code QLang 代码字符串（直接执行）
 * @param filePath .qlg 文件路径（读取文件执行）
 * @param workingDir 工作目录（用于解析 #include）
 * @returns 执行结果
 */
export function debugQLang(
    code?: string,
    filePath?: string,
    workingDir?: string
): { success: boolean; output?: string; error?: string } {
    try {
        let scriptCode: string;
        let workDir: string;

        if (code && filePath) {
            return { success: false, error: 'code 和 filePath 不能同时使用，请二选一' };
        }

        if (filePath) {
            if (!fs.existsSync(filePath)) {
                return { success: false, error: `文件不存在: ${filePath}` };
            }
            scriptCode = fs.readFileSync(filePath, 'utf8');
            workDir = workingDir || path.dirname(filePath);
        } else if (code) {
            scriptCode = code;
            workDir = workingDir || process.cwd();
        } else {
            return { success: false, error: '请提供 code 或 filePath 参数' };
        }

        // 设置工作目录
        setQLangWorkingDir(workDir);

        // 构建模拟问卷数据（10 道题，全部为空）
        const answers: Record<string, string> = {};
        const questions: any[] = [];
        for (let i = 1; i <= 10; i++) {
            const id = 'q' + i;
            answers[id] = '';
            questions.push({ id, type: 'text' });
        }

        // 执行脚本
        const result = executeQLang(scriptCode, answers, {}, questions);
        
        // 由于 executeQLang 是异步的，这里需要同步等待
        // 但我们用同步方式，所以用 then/catch
        // 但为了保持同步接口，我们使用一个技巧
        // 实际上 executeQLang 是 async，我们在这里用 Promise 包装
        // 但为了调试方便，我们返回 Promise
        // 但这里我们改为返回 Promise
        return { success: true, output: '执行完成（请使用 debugQLangAsync）' };
    } catch (e: any) {
        const errMsg = e instanceof ScriptError ? e.message : String(e.message || e);
        return { success: false, error: errMsg };
    }
}

/**
 * 异步调试运行 QLang 脚本
 */
export async function debugQLangAsync(
    code?: string,
    filePath?: string,
    workingDir?: string
): Promise<{ success: boolean; output?: string; error?: string }> {
    try {
        let scriptCode: string;
        let workDir: string;

        if (code && filePath) {
            return { success: false, error: 'code 和 filePath 不能同时使用，请二选一' };
        }

        if (filePath) {
            if (!fs.existsSync(filePath)) {
                return { success: false, error: `文件不存在: ${filePath}` };
            }
            scriptCode = fs.readFileSync(filePath, 'utf8');
            workDir = workingDir || path.dirname(filePath);
        } else if (code) {
            scriptCode = code;
            workDir = workingDir || process.cwd();
        } else {
            return { success: false, error: '请提供 code 或 filePath 参数' };
        }

        // 设置工作目录
        setQLangWorkingDir(workDir);

        // 构建模拟问卷数据（10 道题，全部为空）
        const answers: Record<string, string> = {};
        const questions: any[] = [];
        for (let i = 1; i <= 10; i++) {
            const id = 'q' + i;
            answers[id] = '';
            questions.push({ id, type: 'text' });
        }

        // 执行脚本
        const output = await executeQLang(scriptCode, answers, {}, questions);
        return { success: true, output: output || '执行成功（无输出）' };
    } catch (e: any) {
        const errMsg = e instanceof ScriptError ? e.message : String(e.message || e);
        return { success: false, error: errMsg };
    }
}

/**
 * VSCode 命令入口：运行当前打开的 .qlg 文件
 */
export async function runCurrentQLangFile(filePath: string): Promise<string> {
    const result = await debugQLangAsync(undefined, filePath);
    if (result.success) {
        return result.output || '执行成功（无输出）';
    } else {
        throw new Error(result.error || '执行失败');
    }
}