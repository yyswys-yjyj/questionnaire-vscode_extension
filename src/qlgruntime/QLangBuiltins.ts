// QLangBuiltins — 内置函数 dispatch
// @ts-nocheck

import { clampValue } from './QLangTypes';

export var globalEnv = {}; // 由 index.ts 设置

// printf 格式化：支持 %d %s %c %x %o %p %lld %llx %hu %lu %u %f 等
export function printfFormat(fmt, args) {
    var ai = 0;
    var result = '';
    var i = 0;
    while (i < fmt.length) {
        if (fmt[i] === '%' && i + 1 < fmt.length) {
            i++;
            if (fmt[i] === '%') { result += '%'; i++; continue; }
            // 读取完整格式符（连续的字母）
            var specStart = i;
            while (i < fmt.length && /[a-zA-Z]/.test(fmt[i])) i++;
            var spec = fmt.substring(specStart, i);
            i--;
            var v = args[ai++];
            var nv = parseInt(v) || 0;
            switch (spec) {
                case 'd': case 'i': result += nv; break;
                case 'u': case 'lu': case 'hu': case 'llu': case 'zu': result += nv >>> 0; break;
                case 'ld': case 'hd': case 'lld': result += nv; break;
                case 's': result += String(v); break;
                case 'c': result += typeof v === 'number' ? String.fromCharCode(v) : String(v).charAt(0) || ''; break;
                case 'x': case 'lx': case 'llx': result += nv.toString(16); break;
                case 'X': case 'lX': case 'llX': result += nv.toString(16).toUpperCase(); break;
                case 'o': result += nv.toString(8); break;
                case 'f': case 'lf': case 'Lf': result += (Number(v) || 0).toFixed(6).replace(/\.?0+$/, ''); break;
                case 'e': case 'le': result += (Number(v) || 0).toExponential(); break;
                case 'g': case 'lg': result += (Number(v) || 0).toPrecision(); break;
                case 'p': result += '0x' + (nv >>> 0).toString(16).padStart(8, '0'); break;
                default: result += '%' + spec;
            }
        } else {
            result += fmt[i];
        }
        i++;
    }
    return result;
}

// 分发内置函数调用
// 返回 undefined 表示不是内置函数，需要由自定义函数处理
export function dispatchBuiltin(expr, executeExpr, scope, startTime, depth) {
    // _gcd
    if (expr.name === '_gcd') {
        var a = Math.abs(executeExpr(expr.args[0], scope, startTime, depth));
        var b = Math.abs(executeExpr(expr.args[1], scope, startTime, depth));
        while (b) { var t = b; b = a % b; a = t; }
        return a;
    }
    // parseInt
    if (expr.name === 'parseInt') {
        return parseInt(String(executeExpr(expr.args[0], scope, startTime, depth))) || 0;
    }
    // 类型转换函数
    var typeCasts = { '_short': true, '_long': true, '_longlong': true, '_int64': true, '_uint': true, '_unsigned': true, '_int32': true, '_int': true };
    if (typeCasts[expr.name]) {
        var raw = executeExpr(expr.args[0], scope, startTime, depth);
        if (typeof raw !== 'number') raw = parseInt(String(raw)) || 0;
        var typeName = expr.name.substring(1); // _.short → short
        return clampValue(raw, typeName);
    }
    // sizeof
    if (expr.name === 'sizeof') {
        var sv = executeExpr(expr.args[0], scope, startTime, depth);
        return Array.isArray(sv) ? sv.length : (typeof sv === 'string' ? sv.length : 0);
    }
    // size (STL通用)
    if (expr.name === 'size') {
        var sv2 = executeExpr(expr.args[0], scope, startTime, depth);
        if (sv2 && typeof sv2.size === 'function') return sv2.size();
        if (Array.isArray(sv2)) return sv2.length;
        return 0;
    }
    // strlen
    if (expr.name === 'strlen') {
        var sl = executeExpr(expr.args[0], scope, startTime, depth);
        return typeof sl === 'string' ? sl.length : (Array.isArray(sl) ? sl.indexOf('\0') >= 0 ? sl.indexOf('\0') : sl.length : 0);
    }
    // printf
    if (expr.name === 'printf') {
        var fmt = String(executeExpr(expr.args[0], scope, startTime, depth));
        var pArgs = [];
        for (var pa = 1; pa < expr.args.length; pa++) pArgs.push(executeExpr(expr.args[pa], scope, startTime, depth));
        var out = printfFormat(fmt, pArgs);
        if (globalEnv && globalEnv['__outputs__']) globalEnv['__outputs__'].push(out);
        return pArgs.length;
    }
    // abort
    if (expr.name === 'abort') {
        var abortMsg = expr.args.length > 0 ? String(executeExpr(expr.args[0], scope, startTime, depth)) : 'abort';
        throw new ScriptError("abort: " + abortMsg);
    }
    return undefined; // 不是内置函数
}

export function stringify(v) {
    if (v === true) return '1';
    if (v === false) return '0';
    if (v === undefined || v === null) return '';
    return String(v);
}

export function isTruthy(v) {
    return v !== false && v !== 0 && v !== '' && v !== null && v !== undefined;
}

function ScriptError(msg, line) {
    this.message = msg;
    this.line = line;
}
ScriptError.prototype = Object.create(Error.prototype);
ScriptError.prototype.constructor = ScriptError;
export { ScriptError };