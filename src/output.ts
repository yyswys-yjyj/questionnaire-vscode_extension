// output.ts — QLang 输出格式化

/**
 * 格式化 QLang 脚本执行输出
 */
export function formatQLangOutput(lines: string[]): string {
    if (!lines || lines.length === 0) {
        return '';
    }
    return '\n\n── 结果 ──\n' + lines.join('\n');
}

/**
 * 格式化 QLang 错误信息
 */
export function formatQLangError(errMsg: string): string {
    return '\n\n── 错误 ──\n' + errMsg;
}