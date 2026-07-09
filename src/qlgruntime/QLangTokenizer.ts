// QLangTokenizer — 词法分析（tokenizer）
// @ts-nocheck

import { TOKENIZER_KEYWORDS } from './QLangTypes';

export function removeQLangComments(code) {
    code = code.replace(/\/\/.*$/gm, '');
    code = code.replace(/\/\*[\s\S]*?\*\//g, '');
    return code;
}

export function tokenize(code) {
    code = removeQLangComments(code);
    var tokens = [];
    var i = 0;
    var line = 1;
    while (i < code.length) {
        var c = code[i];
        if (/\s/.test(c)) {
            if (c === '\n') line++;
            i++;
            continue;
        }
        // 字符串字面量
        if (c === '"' || c === "'") {
            var quote = c;
            var start = i;
            i++;
            while (i < code.length && code[i] !== quote) {
                if (code[i] === '\\' && i + 1 < code.length) i += 2;
                else i++;
            }
            if (i < code.length) i++;
            tokens.push({ type: 'string', value: code.substring(start, i), line: line });
            continue;
        }
        // 数字（支持 1e9、0x 十六进制、小数点）
        if (/[0-9]/.test(c) || (c === '.' && i + 1 < code.length && /[0-9]/.test(code[i + 1]))) {
            var start = i;
            if (code[i] === '0' && i + 1 < code.length && (code[i + 1] === 'x' || code[i + 1] === 'X')) {
                i += 2;
                while (i < code.length && /[0-9a-fA-F]/.test(code[i])) i++;
            } else {
                while (i < code.length && /[0-9.eE]/.test(code[i])) i++;
            }
            tokens.push({ type: 'number', value: code.substring(start, i), line: line });
            continue;
        }
        // $PHP风格变量名
        if (c === '$') {
            var start = i;
            i++;
            while (i < code.length && /[a-zA-Z0-9_]/.test(code[i])) i++;
            tokens.push({ type: 'phpVar', value: code.substring(start, i), line: line });
            continue;
        }
        // 标识符/关键字
        if (/[a-zA-Z_]/.test(c)) {
            var start = i;
            while (i < code.length && /[a-zA-Z0-9_]/.test(code[i])) i++;
            var word = code.substring(start, i);
            tokens.push({ type: TOKENIZER_KEYWORDS[word] ? 'keyword' : 'identifier', value: word, line: line });
            continue;
        }
        // 多字符操作符
        var twoChar = code.substring(i, i + 2);
        var twoOps = { '++': true, '--': true, '<<': true, '>>': true, '>=': true, '<=': true, '==': true, '!=': true,
            '&&': true, '||': true, '+=': true, '-=': true, '*=': true, '/=': true, '%=': true, '->': true, '::': true };
        if (twoOps[twoChar]) {
            tokens.push({ type: 'operator', value: twoChar, line: line });
            i += 2;
            continue;
        }
        // #include 指令
        if (c === '#' && code.substring(i, i + 8) === '#include') {
            var incStart = i;
            i += 8;
            while (i < code.length && code[i] !== '\n' && code[i] !== '\r') i++;
            var incLine = code.substring(incStart, i).trim();
            tokens.push({ type: 'include', value: incLine, line: line });
            continue;
        }
        // #define 指令
        if (c === '#' && code.substring(i, i + 7) === '#define') {
            i += 7;
            while (i < code.length && (code[i] === ' ' || code[i] === '\t')) i++;
            var macroStart = i;
            while (i < code.length && /[a-zA-Z0-9_]/.test(code[i])) i++;
            var macroName = code.substring(macroStart, i);
            while (i < code.length && (code[i] === ' ' || code[i] === '\t')) i++;
            var macroValueStart = i;
            while (i < code.length && code[i] !== '\n' && code[i] !== '\r') i++;
            var macroValue = code.substring(macroValueStart, i).trim();
            tokens.push({ type: 'define', name: macroName, value: macroValue, line: line });
            continue;
        }
        // #gc 指令：释放指定变量
        if (c === '#' && code.substring(i, i + 3) === '#gc') {
            i += 3;
            while (i < code.length && (code[i] === ' ' || code[i] === '\t')) i++;
            var gcStart = i;
            while (i < code.length && /[a-zA-Z0-9_]/.test(code[i])) i++;
            var gcVar = code.substring(gcStart, i);
            tokens.push({ type: 'gc', varName: gcVar, line: line });
            continue;
        }
        // @ （已迁移至 QinitCode，QLang 中作为普通符号）
        // @ 原问卷操作符指令已移除，@ 作为普通 symbol 处理
        tokens.push({ type: 'symbol', value: c, line: line });
        i++;
    }
    return tokens;
}
