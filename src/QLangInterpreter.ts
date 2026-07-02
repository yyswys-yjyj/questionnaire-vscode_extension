// QLang v2.1 — 地址表 + 作用域链 + 指针
// VSCode 插件适配版

import * as fs from 'fs';
import * as path from 'path';

// ============ 常量定义 ============
const QLANG_MAX_STACK_DEPTH = 5000;
const QLANG_TIMEOUT_MS = 10000;
const QLANG_TOTAL_TIMEOUT_MS = 10000;
const QLANG_MAX_ARRAY_SIZE = 5000000;
const QLANG_MAX_VARS = 500;
const QLANG_MAX_2D_ARRAY = 1000000;
const QLANG_MEMORY_SIZE = 268435456;

// ============ 内存管理 ============
let QLANG_MEMORY: any[] = new Array(QLANG_MEMORY_SIZE);
let QLANG_NEXT_ADDR = 1;
let QLANG_SCOPE_ID = 0;

// 当前执行的主文件所在目录（用于解析库文件路径）
let _currentWorkingDir: string = process.cwd();

/**
 * 设置当前工作目录（用于解析 #include 路径）
 * 在 executeQLang 入口处调用，传入主文件所在目录
 */
export function setQLangWorkingDir(dir: string): void {
    _currentWorkingDir = dir;
}

// ============ 错误类 ============
export class ScriptError extends Error {
    constructor(msg: string) {
        super(msg);
        this.name = "ScriptError";
    }
}

// ============ 内存管理函数 ============
function allocAddr(): number {
    if (QLANG_NEXT_ADDR >= QLANG_MEMORY_SIZE) {
        throw new ScriptError("内存空间超限");
    }
    return QLANG_NEXT_ADDR++;
}

// ============ 作用域 ============
function createScope(parent: any): any {
    return { id: QLANG_SCOPE_ID++, parent: parent, vars: {} };
}

function declareVar(scope: any, name: string, value: any, type: string, isConst: boolean): number {
    const addr = allocAddr();
    QLANG_MEMORY[addr] = value;
    scope.vars[name] = { addr: addr, type: type, isConst: !!isConst };
    return addr;
}

function declareArray(scope: any, name: string, size: number, type: string, initFn?: (i: number) => any): number {
    const addr = allocAddr();
    const arr = new Array(size);
    const dv = defaultValue(type);
    for (let i = 0; i < size; i++) {
        arr[i] = initFn ? initFn(i) : dv;
    }
    QLANG_MEMORY[addr] = arr;
    scope.vars[name] = { addr: addr, type: type + "[]", isConst: false };
    return addr;
}

function findVar(scope: any, name: string): { info: any; scope: any } | null {
    let s = scope;
    while (s) {
        if (s.vars[name] !== undefined) {
            return { info: s.vars[name], scope: s };
        }
        s = s.parent;
    }
    return null;
}

function getVar(scope: any, name: string): any {
    const found = findVar(scope, name);
    if (!found) {
        throw new ScriptError("未定义: " + name);
    }
    return QLANG_MEMORY[found.info.addr];
}

function setVar(scope: any, name: string, value: any): void {
    const found = findVar(scope, name);
    if (!found) {
        declareVar(scope, name, value, "auto", false);
        return;
    }
    if (found.info.isConst) {
        throw new ScriptError("不能修改 const: " + name);
    }
    QLANG_MEMORY[found.info.addr] = value;
}

function addrOf(scope: any, name: string): number {
    const found = findVar(scope, name);
    if (!found) {
        throw new ScriptError("未定义: " + name);
    }
    return found.info.addr;
}

// ============ 类型默认值 ============
function defaultValue(type: string): any {
    if (type === 'stack' || type === 'queue' || type === 'vector' || type === 'priority_queue') {
        return createSTLObject(type);
    }
    if (type === 'pair') return { first: 0, second: 0 };
    const map: Record<string, any> = {
        'int': 0,
        'float': 0.0,
        'double': 0.0,
        'char': '',
        'string': '',
        'bool': false,
        'void': 0
    };
    return map[type] !== undefined ? map[type] : 0;
}

// ============ STL 容器工厂 ============
function createSTLObject(type: string): any {
    switch (type) {
        case 'stack': {
            const arr: any[] = [];
            return {
                __stl_type: 'stack',
                _data: arr,
                push: function(v: any) {
                    if (arr.length >= 1000) throw new ScriptError('stack overflow (max 1000)');
                    arr.push(v);
                },
                pop: function() {
                    if (arr.length === 0) throw new ScriptError('stack empty');
                    arr.pop();
                },
                top: function() {
                    if (arr.length === 0) throw new ScriptError('stack empty');
                    return arr[arr.length - 1];
                },
                size: function() { return arr.length; },
                empty: function() { return arr.length === 0; }
            };
        }
        case 'queue': {
            const arr: any[] = [];
            return {
                __stl_type: 'queue',
                _data: arr,
                push: function(v: any) {
                    if (arr.length >= 1000) throw new ScriptError('queue overflow (max 1000)');
                    arr.push(v);
                },
                pop: function() {
                    if (arr.length === 0) throw new ScriptError('queue empty');
                    arr.shift();
                },
                front: function() {
                    if (arr.length === 0) throw new ScriptError('queue empty');
                    return arr[0];
                },
                back: function() {
                    if (arr.length === 0) throw new ScriptError('queue empty');
                    return arr[arr.length - 1];
                },
                size: function() { return arr.length; },
                empty: function() { return arr.length === 0; }
            };
        }
        case 'vector': {
            const arr: any[] = [];
            return {
                __stl_type: 'vector',
                _data: arr,
                push_back: function(v: any) { arr.push(v); },
                pop_back: function() {
                    if (arr.length === 0) throw new ScriptError('vector empty');
                    arr.pop();
                },
                get: function(i: number) {
                    if (i < 0 || i >= arr.length) throw new ScriptError('vector index out of range');
                    return arr[i];
                },
                set: function(i: number, v: any) {
                    if (i < 0 || i >= arr.length) throw new ScriptError('vector index out of range');
                    arr[i] = v;
                },
                size: function() { return arr.length; },
                empty: function() { return arr.length === 0; },
                clear: function() { arr.length = 0; }
            };
        }
        case 'priority_queue': {
            const arr: any[] = [];
            function siftUp(idx: number) {
                while (idx > 0) {
                    const p = Math.floor((idx - 1) / 2);
                    if (arr[p] >= arr[idx]) break;
                    [arr[p], arr[idx]] = [arr[idx], arr[p]];
                    idx = p;
                }
            }
            function siftDown(idx: number) {
                const n = arr.length;
                while (true) {
                    let largest = idx;
                    const l = 2 * idx + 1, r = 2 * idx + 2;
                    if (l < n && arr[l] > arr[largest]) largest = l;
                    if (r < n && arr[r] > arr[largest]) largest = r;
                    if (largest === idx) break;
                    [arr[idx], arr[largest]] = [arr[largest], arr[idx]];
                    idx = largest;
                }
            }
            return {
                __stl_type: 'priority_queue',
                _data: arr,
                push: function(v: any) {
                    if (arr.length >= 1000) throw new ScriptError('priority_queue overflow (max 1000)');
                    arr.push(v);
                    siftUp(arr.length - 1);
                },
                pop: function() {
                    if (arr.length === 0) throw new ScriptError('priority_queue empty');
                    arr[0] = arr[arr.length - 1];
                    arr.pop();
                    if (arr.length > 0) siftDown(0);
                },
                top: function() {
                    if (arr.length === 0) throw new ScriptError('priority_queue empty');
                    return arr[0];
                },
                size: function() { return arr.length; },
                empty: function() { return arr.length === 0; }
            };
        }
        default:
            return 0;
    }
}

// ============ 工具函数 ============
function stripLineNumbers(s: string): string {
    if (typeof s !== "string") return "";
    return s.replace(/^\s*(?:\d+\|\s*)+/gm, "");
}

/**
 * 从文件系统读取库文件
 * 路径基于当前工作目录（_currentWorkingDir）
 */
function readLibraryFileSync(libName: string): string {
    // 先尝试从工作目录下的 library 文件夹读取
    let libPath = path.join(_currentWorkingDir, 'library', libName + '.qlg');
    
    // 如果不存在，尝试从当前工作目录直接读取
    if (!fs.existsSync(libPath)) {
        libPath = path.join(_currentWorkingDir, libName + '.qlg');
    }
    
    if (!fs.existsSync(libPath)) {
        throw new ScriptError(`[库: ${libName}.qlg] 文件不存在 (搜索路径: ${_currentWorkingDir}/library/, ${_currentWorkingDir}/)`);
    }
    
    try {
        const raw = fs.readFileSync(libPath, 'utf8');
        if (!raw || raw.trim() === '') {
            throw new ScriptError(`[库: ${libName}.qlg] 文件为空`);
        }
        return stripLineNumbers(raw);
    } catch (err: any) {
        throw new ScriptError(`[库: ${libName}.qlg] 读取失败: ${err.message}`);
    }
}

function removeQLangComments(code: string): string {
    // 去除 // 单行注释
    code = code.replace(/\/\/.*$/gm, '');
    // 去除 /* */ 块注释
    code = code.replace(/\/\*[\s\S]*?\*\//g, '');
    return code;
}

// ============ 辅助函数（用于执行器） ============
function isTruthy(v: any): boolean {
    return v !== false && v !== 0 && v !== '' && v !== null && v !== undefined;
}

function stringify(v: any): string {
    if (v === true) return '1';
    if (v === false) return '0';
    if (v === undefined || v === null) return '';
    return String(v);
}

// printf 格式化：支持 %d %s %c %x %o %p
function printfFormat(fmt: string, args: any[]): string {
    let ai = 0;
    let result = '';
    let i = 0;
    while (i < fmt.length) {
        if (fmt[i] === '%' && i + 1 < fmt.length) {
            i++;
            const spec = fmt[i];
            if (spec === '%') { result += '%'; i++; continue; }
            const v = args[ai++];
            switch (spec) {
                case 'd': result += parseInt(v) || 0; break;
                case 's': result += String(v); break;
                case 'c': result += typeof v === 'number' ? String.fromCharCode(v) : String(v).charAt(0) || ''; break;
                case 'x': result += (parseInt(v) || 0).toString(16); break;
                case 'o': result += (parseInt(v) || 0).toString(8); break;
                case 'p': result += '0x' + (v >>> 0).toString(16).padStart(8, '0'); break;
                default: result += '%' + spec;
            }
        } else {
            result += fmt[i];
        }
        i++;
    }
    return result;
}

// ============ 分词器 ============
interface Token {
    type: string;
    value: string;
    line: number;
}

function tokenize(code: string): Token[] {
    code = removeQLangComments(code);
    const tokens: Token[] = [];
    let i = 0;
    let line = 1;
    
    while (i < code.length) {
        const c = code[i];
        
        // 跳过空白
        if (/\s/.test(c)) {
            if (c === '\n') line++;
            i++;
            continue;
        }
        
        // 字符串字面量
        if (c === '"' || c === "'") {
            const quote = c;
            const start = i;
            i++;
            while (i < code.length && code[i] !== quote) {
                if (code[i] === '\\' && i + 1 < code.length) i += 2;
                else i++;
            }
            if (i < code.length) i++;
            tokens.push({ type: 'string', value: code.substring(start, i), line });
            continue;
        }
        
        // 数字
        if (/[0-9]/.test(c) || (c === '.' && i + 1 < code.length && /[0-9]/.test(code[i + 1]))) {
            const start = i;
            if (code[i] === '0' && i + 1 < code.length && (code[i + 1] === 'x' || code[i + 1] === 'X')) {
                i += 2;
                while (i < code.length && /[0-9a-fA-F]/.test(code[i])) i++;
            } else {
                while (i < code.length && /[0-9.eE]/.test(code[i])) i++;
            }
            tokens.push({ type: 'number', value: code.substring(start, i), line });
            continue;
        }
        
        // $PHP风格变量名
        if (c === '$') {
            const start = i;
            i++;
            while (i < code.length && /[a-zA-Z0-9_]/.test(code[i])) i++;
            tokens.push({ type: 'phpVar', value: code.substring(start, i), line });
            continue;
        }
        
        // 标识符/关键字
        if (/[a-zA-Z_]/.test(c)) {
            const start = i;
            while (i < code.length && /[a-zA-Z0-9_]/.test(code[i])) i++;
            const word = code.substring(start, i);
            const keywords: Record<string, boolean> = {
                'int': true, 'float': true, 'double': true, 'char': true,
                'string': true, 'bool': true, 'true': true, 'false': true,
                'if': true, 'else': true, 'while': true, 'for': true,
                'return': true, 'void': true, 'const': true,
                'break': true, 'continue': true,
                'stack': true, 'queue': true, 'vector': true,
                'pair': true, 'priority_queue': true,
                'struct': true, 'new': true,
                'try': true, 'catch': true, 'throw': true
            };
            tokens.push({
                type: keywords[word] ? 'keyword' : 'identifier',
                value: word,
                line
            });
            continue;
        }
        
        // 多字符操作符
        const twoChar = code.substring(i, i + 2);
        const twoOps: Record<string, boolean> = {
            '++': true, '--': true, '<<': true, '>>': true,
            '>=': true, '<=': true, '==': true, '!=': true,
            '&&': true, '||': true,
            '+=': true, '-=': true, '*=': true, '/=': true, '%=': true,
            '->': true, '::': true
        };
        if (twoOps[twoChar]) {
            tokens.push({ type: 'operator', value: twoChar, line });
            i += 2;
            continue;
        }
        
        // #include 指令预处理器
        if (c === '#' && code.substring(i, i + 8) === '#include') {
            const incStart = i;
            i += 8;
            while (i < code.length && code[i] !== '\n' && code[i] !== '\r') i++;
            const incLine = code.substring(incStart, i).trim();
            tokens.push({ type: 'include', value: incLine, line });
            continue;
        }
        
        tokens.push({ type: 'symbol', value: c, line });
        i++;
    }
    
    return tokens;
}

// ============ 解析器 ============
interface ParseResult {
    namespaces: Record<string, { functions: Record<string, any> }>;
    globalStmts: any[];
    namespace?: string;  // 添加可选属性
    hasDefNS?: boolean;
}

function parse(code: string, extraAsts?: Record<string, ParseResult>): ParseResult {
    const tokens = tokenize(code);
    let pos = 0;
    const structTypeNames: Record<string, boolean> = {};
    let hasDefNS = false;
    
    function peek(): Token { return pos < tokens.length ? tokens[pos] : { type: 'eof', value: '', line: 0 }; }
    function consume(): Token { return pos < tokens.length ? tokens[pos++] : { type: 'eof', value: '', line: 0 }; }
    function expect(type: string, value?: string): Token {
        const t = consume();
        if (t.type !== type || (value !== undefined && t.value !== value)) {
            throw new ScriptError(`第${t.line || '?'}行: 期望 ${value || type}，得到 ${t.value}`);
        }
        return t;
    }
    
    // ---- 解析函数 ----
    function parseFunction(): any {
        const returnType = consume().value;
        const name = expect('identifier').value;
        expect('symbol', '(');
        const params: any[] = [];
        while (peek().value !== ')') {
            const pType = consume().value;
            const pName = expect('identifier').value;
            params.push({ type: pType, name: pName });
            if (peek().value === ',') consume();
        }
        expect('symbol', ')');
        expect('symbol', '{');
        const body = parseBlock();
        return { type: 'function', returnType, name, params, body };
    }
    
    function parseStructDef(): any {
        consume(); // struct
        const name = expect('identifier').value;
        structTypeNames[name] = true;
        expect('symbol', '{');
        const fields: any[] = [];
        while (peek().value !== '}') {
            const ft = consume().value;
            const fn = expect('identifier').value;
            expect('symbol', ';');
            fields.push({ type: ft, name: fn });
        }
        expect('symbol', '}');
        expect('symbol', ';');
        return { type: 'structDef', structName: name, fields };
    }
    
    function parseBlock(): any[] {
        const stmts: any[] = [];
        while (peek().value !== '}' && peek().type !== 'eof') {
            stmts.push(parseStatement());
        }
        if (peek().value === '}') consume();
        return stmts;
    }
    
    function parseStatement(): any {
        // 空语句
        if (peek().value === ';') { consume(); return { type: 'empty' }; }
        // 块
        if (peek().value === '{') {
            consume();
            return { type: 'block', body: parseBlock() };
        }
        
        const typeKeywords: Record<string, boolean> = {
            'int': true, 'float': true, 'double': true, 'char': true,
            'string': true, 'bool': true,
            'stack': true, 'queue': true, 'vector': true,
            'pair': true, 'priority_queue': true
        };
        
        // 检测函数定义
        let isFuncDef = false;
        function looksLikeFunc(p: number): boolean {
            let i = p;
            if (peek().value === 'void') { i += 1; } else { i += 2; }
            if (i < tokens.length && tokens[i].value === '(') return true;
            while (i < tokens.length && tokens[i].value !== '(' && tokens[i].value !== '{' && tokens[i].value !== ';' && tokens[i].value !== '=') {
                i++;
            }
            return i < tokens.length && tokens[i].value === '(';
        }
        if (peek().value === 'void' || typeKeywords[peek().value]) {
            if (tokens[pos + 1] && tokens[pos + 1].type === 'identifier' && looksLikeFunc(pos)) {
                isFuncDef = true;
            }
        }
        if (isFuncDef) {
            return parseFunction();
        }
        
        // 变量声明
        if (typeKeywords[peek().value] || (peek().value === 'const' && tokens[pos + 1] && typeKeywords[tokens[pos + 1].value])) {
            return parseVarDecl();
        }
        
        // 结构体指针变量 Node* name
        if (peek().type === 'identifier' && tokens[pos + 1] && tokens[pos + 1].value === '*' && tokens[pos + 2] && tokens[pos + 2].type === 'identifier') {
            return parseStructPtrDecl();
        }
        // 结构体变量 Node name
        if (peek().type === 'identifier' && tokens[pos + 1] && tokens[pos + 1].type === 'identifier' && structTypeNames[peek().value]) {
            return parseStructPtrDecl(false);
        }
        // 结构体定义
        if (peek().value === 'struct') {
            return parseStructDef();
        }
        // PHP变量
        if (peek().type === 'phpVar' && tokens[pos + 1] && tokens[pos + 1].value === '=') {
            return parsePhpVarDecl();
        }
        
        // 关键字语句
        if (peek().value === 'if') return parseIf();
        if (peek().value === 'while') return parseWhile();
        if (peek().value === 'for') return parseFor();
        if (peek().value === 'return') return parseReturn();
        if (peek().value === 'cout') return parseCout();
        if (peek().value === 'print') return parsePrint();
        if (peek().value === 'break') { consume(); expect('symbol', ';'); return { type: 'break' }; }
        if (peek().value === 'continue') { consume(); expect('symbol', ';'); return { type: 'continue' }; }
        if (peek().value === 'try') return parseTryCatch();
        if (peek().value === 'throw') return parseThrow();
        
        return parseExpressionStmt();
    }
    
    function parseTryCatch(): any {
        consume();
        expect('symbol', '{');
        const tryBody = parseBlock();
        const cToken = consume();
        if (cToken.value !== 'catch') throw new ScriptError('期望 catch');
        expect('symbol', '(');
        const catchVar = expect('identifier').value;
        expect('symbol', ')');
        expect('symbol', '{');
        const catchBody = parseBlock();
        return { type: 'tryCatch', tryBody, catchVar, catchBody };
    }
    
    function parseThrow(): any {
        consume();
        const val = parseExpression();
        expect('symbol', ';');
        return { type: 'throw', value: val };
    }
    
    function parsePhpVarDecl(): any {
        const name = consume().value;
        consume(); // =
        const init = parseExpression();
        expect('symbol', ';');
        return { type: 'phpVarDecl', name, init };
    }
    
    function parseStructPtrDecl(isPtr: boolean = true): any {
        const typeName = consume().value;
        if (isPtr) consume(); // 消耗 *
        const name = expect('identifier').value;
        let init = null;
        if (peek().value === '=') { consume(); init = parseExpression(); }
        expect('symbol', ';');
        return { type: 'varDecl', varType: typeName + (isPtr ? '*' : ''), name, init, isConst: false };
    }
    
    function parseVarDecl(): any {
        let isConst = false;
        if (peek().value === 'const') { isConst = true; consume(); }
        const type = consume().value;
        let isPtr = false;
        if (peek().value === '*') { isPtr = true; consume(); }
        else if (peek().type === 'operator' && peek().value === '*') { isPtr = true; consume(); }
        const name = expect('identifier').value;
        let init = null;
        
        // 数组声明
        if (peek().value === '[') {
            consume();
            let sizeExpr1 = null;
            if (peek().value !== ']') {
                sizeExpr1 = parseExpression();
            }
            expect('symbol', ']');
            let sizeExpr2 = null;
            if (peek().value === '[') {
                consume();
                if (peek().value !== ']') {
                    sizeExpr2 = parseExpression();
                }
                expect('symbol', ']');
            }
            let initArr = null;
            let initStr = null;
            if (peek().value === '=') {
                consume();
                if ((type === 'char' || type === 'string') && (peek().type === 'string')) {
                    initStr = consume().value;
                } else {
                    expect('symbol', '{');
                    initArr = parseArrayInit();
                }
            }
            expect('symbol', ';');
            if (sizeExpr2 !== null) {
                return { type: 'arrayDecl2D', varType: type, name, size1: sizeExpr1, size2: sizeExpr2, init: initArr, isConst };
            }
            return { type: 'arrayDecl', varType: type, name, size: sizeExpr1, init: initArr, initStr, isConst };
        }
        
        if (peek().value === '=') {
            consume();
            init = parseExpression();
        }
        expect('symbol', ';');
        return { type: 'varDecl', varType: type, name, init, isConst };
    }
    
    function parseArrayInit(): any[] {
        const values: any[] = [];
        while (peek().value !== '}') {
            if (peek().value === '{') {
                consume();
                values.push(parseArrayInit());
            } else {
                values.push(parseExpression());
            }
            if (peek().value === ',') consume();
        }
        expect('symbol', '}');
        return values;
    }
    
    function parseIf(): any {
        consume();
        expect('symbol', '(');
        const cond = parseExpression();
        expect('symbol', ')');
        const then = parseStatement();
        let elseStmt = null;
        if (peek().value === 'else') {
            consume();
            elseStmt = parseStatement();
        }
        return { type: 'if', cond, then, else: elseStmt };
    }
    
    function parseWhile(): any {
        consume();
        expect('symbol', '(');
        const cond = parseExpression();
        expect('symbol', ')');
        const body = parseStatement();
        return { type: 'while', cond, body };
    }
    
    function parseFor(): any {
        consume();
        expect('symbol', '(');
        let init = null;
        if (peek().value !== ';') {
            if (peek().type === 'phpVar' && tokens[pos + 1] && tokens[pos + 1].value === '=') {
                const pName = consume().value;
                consume();
                init = { type: 'phpVarDecl', name: pName, init: parseExpression() };
            } else if (peek().type === 'identifier' && tokens[pos + 1] && (tokens[pos + 1].value === '=' || tokens[pos + 1].value === '+=' || tokens[pos + 1].value === '-=')) {
                const iName = consume().value;
                const iOp = consume().value;
                init = { type: 'assign', name: iName, value: parseExpression() };
            } else {
                init = parseStatementPart();
            }
        }
        expect('symbol', ';');
        let cond = null;
        if (peek().value !== ';') cond = parseExpression();
        expect('symbol', ';');
        let inc = null;
        if (peek().value !== ')') {
            if (peek().type === 'identifier' && tokens[pos + 1] && (tokens[pos + 1].value === '=' || tokens[pos + 1].value === '+=' || tokens[pos + 1].value === '-=')) {
                const incName = consume().value;
                const incOp = consume().value;
                inc = { type: 'forInc', name: incName, op: incOp, value: parseExpression() };
            } else {
                inc = parseExpression();
            }
        }
        expect('symbol', ')');
        const body = parseStatement();
        return { type: 'for', init, cond, inc, body };
    }
    
    function parseReturn(): any {
        consume();
        let value = null;
        if (peek().value !== ';') value = parseExpression();
        expect('symbol', ';');
        return { type: 'return', value };
    }
    
    function parseCout(): any {
        consume();
        expect('operator', '<<');
        const parts: any[] = [];
        while (peek().value !== ';') {
            if (peek().value === 'endl') {
                consume();
                parts.push({ type: 'endl' });
            } else {
                parts.push(parseExpression());
            }
            if (peek().value === '<<') consume();
        }
        expect('symbol', ';');
        return { type: 'cout', parts };
    }
    
    function parsePrint(): any {
        consume();
        expect('symbol', '(');
        const args: any[] = [];
        while (peek().value !== ')') {
            args.push(parseExpression());
            if (peek().value === ',') consume();
        }
        expect('symbol', ')');
        expect('symbol', ';');
        return { type: 'print', args };
    }
    
    function parseStatementPart(): any {
        const typeKeywords: Record<string, boolean> = {
            'int': true, 'float': true, 'double': true, 'char': true,
            'string': true, 'bool': true,
            'stack': true, 'queue': true, 'vector': true,
            'pair': true, 'priority_queue': true
        };
        if (typeKeywords[peek().value]) {
            const type = consume().value;
            const name = expect('identifier').value;
            let init = null;
            if (peek().value === '=') { consume(); init = parseExpression(); }
            return { type: 'varDecl', varType: type, name, init };
        }
        return parseExpression();
    }
    
    function parseExpressionStmt(): any {
        if (peek().type === 'identifier' && tokens[pos + 1]) {
            const lookAhead = tokens[pos + 1].value;
            
            if (lookAhead === '[') {
                const arrName = consume().value;
                consume();
                const arrIdx = parseExpression();
                expect('symbol', ']');
                if (peek().value === '=' || peek().value === '+=' || peek().value === '-=') {
                    const arrOp = consume().value;
                    const arrVal = parseExpression();
                    expect('symbol', ';');
                    return { type: 'arrAssign', name: arrName, index: arrIdx, op: arrOp, value: arrVal };
                }
                pos = pos - 3;
                const expr = parseExpression();
                expect('symbol', ';');
                return { type: 'expr', expr };
            }
            
            if (lookAhead === '=' && tokens[pos + 2] && tokens[pos + 2].value !== '=') {
                const name = consume().value;
                consume();
                const value = parseExpression();
                expect('symbol', ';');
                return { type: 'assign', name, value };
            }
            
            if (lookAhead === '+=' || lookAhead === '-=') {
                const name = consume().value;
                const op = consume().value;
                const value = parseExpression();
                expect('symbol', ';');
                return { type: 'compAssign', name, op, value };
            }
            
            if (lookAhead === '.' && tokens[pos + 2] && tokens[pos + 3] && tokens[pos + 3].value === '=') {
                const objName = consume().value;
                consume();
                const memberName = expect('identifier').value;
                consume();
                const value = parseExpression();
                expect('symbol', ';');
                return { type: 'memberAssign', obj: objName, member: memberName, value };
            }
            
            if (tokens[pos + 1] && tokens[pos + 1].type === 'operator' && tokens[pos + 1].value === '->' && tokens[pos + 2] && tokens[pos + 3] && tokens[pos + 3].value === '=') {
                const ptrName = consume().value;
                consume();
                const arrowMember = expect('identifier').value;
                consume();
                const value = parseExpression();
                expect('symbol', ';');
                return { type: 'arrowAssign', ptr: ptrName, member: arrowMember, value };
            }
        }
        
        if (peek().value === '(') {
            const savedPos = pos;
            consume();
            if (peek().value === '*') {
                consume();
                if (peek().type === 'identifier') {
                    const derefName = consume().value;
                    if (peek().value === ')') {
                        consume();
                        if (peek().value === '.' && tokens[pos + 1] && tokens[pos + 2] && tokens[pos + 2].value === '=') {
                            consume();
                            const memberName = expect('identifier').value;
                            consume();
                            const value = parseExpression();
                            expect('symbol', ';');
                            return { type: 'derefAssign', ptrName: derefName, member: memberName, value };
                        }
                    }
                }
            }
            pos = savedPos;
        }
        
        const expr = parseExpression();
        expect('symbol', ';');
        return { type: 'expr', expr };
    }
    
    // ---- 表达式解析 ----
    function parseExpression(): any {
        return parseLogic();
    }
    
    function parseLogic(): any {
        let left = parseCompare();
        while (peek().value === '&&' || peek().value === '||' || peek().value === 'and' || peek().value === 'or') {
            const op = consume().value;
            const right = parseCompare();
            left = { type: 'binary', op, left, right };
        }
        return left;
    }
    
    const cmpOps: Record<string, boolean> = { '>': true, '<': true, '>=': true, '<=': true, '==': true, '!=': true };
    
    function parseCompare(): any {
        let left = parseAddSub();
        let op = peek().value;
        const nextOp = op + (tokens[pos + 1]?.value || '');
        if (cmpOps[op] || cmpOps[nextOp]) {
            if (cmpOps[nextOp]) { op = nextOp; consume(); }
            consume();
            const right = parseAddSub();
            return { type: 'binary', op, left, right };
        }
        return left;
    }
    
    function parseAddSub(): any {
        let left = parseMulDiv();
        while (peek().value === '+' || peek().value === '-') {
            const op = consume().value;
            const right = parseMulDiv();
            left = { type: 'binary', op, left, right };
        }
        return left;
    }
    
    function parseMulDiv(): any {
        let left = parseUnary();
        while (peek().value === '*' || peek().value === '/' || peek().value === '%') {
            const op = consume().value;
            const right = parseUnary();
            left = { type: 'binary', op, left, right };
        }
        return left;
    }
    
    function parseUnary(): any {
        if (peek().value === '+' || peek().value === '-' || peek().value === '!') {
            const op = consume().value;
            return { type: 'unary', op, arg: parseUnary() };
        }
        if (peek().value === '++') {
            consume();
            const id = expect('identifier').value;
            return { type: 'unary', op: '++', arg: { type: 'variable', name: id } };
        }
        if (peek().value === '--') {
            consume();
            const id2 = expect('identifier').value;
            return { type: 'unary', op: '--', arg: { type: 'variable', name: id2 } };
        }
        if (peek().value === '&') {
            consume();
            const id = expect('identifier').value;
            return { type: 'addrOf', name: id };
        }
        if (peek().value === '*') {
            consume();
            return { type: 'deref', expr: parseUnary() };
        }
        return parsePrimary();
    }
    
    function parsePrimary(): any {
        const t = peek();
        
        if (t.value === 'new') {
            consume();
            const typeName = consume().value;
            const cArgs: any[] = [];
            if (peek().value === '(') {
                consume();
                while (peek().value !== ')') {
                    cArgs.push(parseExpression());
                    if (peek().value === ',') consume();
                }
                expect('symbol', ')');
            }
            return { type: 'newExpr', structType: typeName, args: cArgs };
        }
        
        if (t.type === 'number') {
            consume();
            return { type: 'number', value: t.value };
        }
        
        if (t.type === 'string') {
            consume();
            let s = t.value.substring(1, t.value.length - 1);
            s = s.replace(/\\n/g, '\n');
            s = s.replace(/\\t/g, '\t');
            s = s.replace(/\\\\/g, '\\');
            s = s.replace(/\\"/g, '"');
            s = s.replace(/\\'/g, "'");
            return { type: 'string', value: s };
        }
        
        if (t.value === 'true' || t.value === 'false') {
            consume();
            return { type: 'bool', value: t.value === 'true' };
        }
        
        if (t.type === 'phpVar') {
            consume();
            const name = t.value;
            if (peek().value === '[') {
                consume();
                const index = parseExpression();
                expect('symbol', ']');
                return { type: 'arrayAccess', name, index };
            }
            return { type: 'variable', name };
        }
        
        if (t.type === 'identifier') {
            consume();
            const name = t.value;
            
            if (peek().type === 'operator' && peek().value === '::') {
                consume();
                const nsName = name;
                if (peek().type !== 'identifier') throw new ScriptError("命名空间限定符后需要函数名");
                const funcName = consume().value;
                if (peek().value === '(') {
                    consume();
                    const nsArgs: any[] = [];
                    while (peek().value !== ')') {
                        nsArgs.push(parseExpression());
                        if (peek().value === ',') consume();
                    }
                    expect('symbol', ')');
                    return { type: 'call', namespace: nsName, name: funcName, args: nsArgs, line: t.line };
                }
                throw new ScriptError("命名空间限定符后需要函数调用");
            }
            
            if (peek().value === '(') {
                consume();
                const args: any[] = [];
                while (peek().value !== ')') {
                    args.push(parseExpression());
                    if (peek().value === ',') consume();
                }
                expect('symbol', ')');
                return { type: 'call', name, args, line: t.line };
            }
            
            if (peek().value === '[') {
                consume();
                const index = parseExpression();
                expect('symbol', ']');
                if (peek().value === '[') {
                    consume();
                    const index2 = parseExpression();
                    expect('symbol', ']');
                    return { type: 'arrayAccess', name, index, index2 };
                }
                return { type: 'arrayAccess', name, index };
            }
            
            if (peek().value === '.') {
                consume();
                const member = expect('identifier').value;
                if (peek().value === '(') {
                    consume();
                    const args: any[] = [];
                    while (peek().value !== ')') {
                        args.push(parseExpression());
                        if (peek().value === ',') consume();
                    }
                    expect('symbol', ')');
                    return { type: 'methodCall', obj: name, method: member, args };
                }
                return { type: 'memberAccess', obj: name, member };
            }
            
            if (peek().value === '->') {
                consume();
                const arrowMember = expect('identifier').value;
                if (peek().value === '(') {
                    consume();
                    const aArgs: any[] = [];
                    while (peek().value !== ')') {
                        aArgs.push(parseExpression());
                        if (peek().value === ',') consume();
                    }
                    expect('symbol', ')');
                    return { type: 'arrowCall', ptr: name, method: arrowMember, args: aArgs };
                }
                return { type: 'arrowAccess', ptr: name, member: arrowMember };
            }
            
            if (peek().value === '++') { consume(); return { type: 'postInc', name }; }
            if (peek().value === '--') { consume(); return { type: 'postDec', name }; }
            return { type: 'variable', name };
        }
        
        if (t.value === '(') {
            consume();
            const expr = parseExpression();
            expect('symbol', ')');
            
            if (peek().value === '.') {
                consume();
                const dotMember = expect('identifier').value;
                if (peek().value === '(') {
                    consume();
                    const dArgs: any[] = [];
                    while (peek().value !== ')') {
                        dArgs.push(parseExpression());
                        if (peek().value === ',') consume();
                    }
                    expect('symbol', ')');
                    return { type: 'methodCall', obj: null, method: dotMember, args: dArgs, base: expr };
                }
                return { type: 'memberAccess', obj: null, member: dotMember, base: expr };
            }
            
            if (peek().value === '->') {
                consume();
                const arrMember = expect('identifier').value;
                if (peek().value === '(') {
                    consume();
                    const aArgs2: any[] = [];
                    while (peek().value !== ')') {
                        aArgs2.push(parseExpression());
                        if (peek().value === ',') consume();
                    }
                    expect('symbol', ')');
                    return { type: 'arrowCall', ptr: null, method: arrMember, args: aArgs2, base: expr };
                }
                return { type: 'arrowAccess2', base: expr, member: arrMember };
            }
            
            return expr;
        }
        
        throw new ScriptError(`第${t.line || '?'}行: 意外的 token: ${t.value}`);
    }
    
    // ---- 顶层解析 ----
    const namespaces: Record<string, { functions: Record<string, any> }> = {
        'qlgstd': { functions: {} }
    };
    
    if (extraAsts) {
        for (const libName in extraAsts) {
            const sub = extraAsts[libName];
            if (sub && sub.namespaces) {
                for (const nsName in sub.namespaces) {
                    if (!namespaces[nsName]) namespaces[nsName] = { functions: {} };
                    for (const fnName in sub.namespaces[nsName].functions) {
                        namespaces[nsName].functions[fnName] = sub.namespaces[nsName].functions[fnName];
                    }
                }
            }
        }
    }
    
    let currentNs = 'qlgstd';
    const globalStmts: any[] = [];
    
    while (peek().type !== 'eof') {
        if (peek().type === 'include') {
            const incTok = consume();
            const incMatch = incTok.value.match(/^#include\s*<([^>]+)>/);
            if (incMatch) {
                const libName = incMatch[1];
                try {
                    const libCode = readLibraryFileSync(libName);
                    const subAst = parse(libCode);
                    for (const nsName in subAst.namespaces) {
                        if (!namespaces[nsName]) namespaces[nsName] = { functions: {} };
                        for (const fnName in subAst.namespaces[nsName].functions) {
                            namespaces[nsName].functions[fnName] = subAst.namespaces[nsName].functions[fnName];
                        }
                    }
                } catch (e: any) {
                    if (e instanceof ScriptError) throw e;
                    throw new ScriptError(`[库: ${libName}.qlg] ${(e as Error).message || "读取失败"}`);
                }
            }
            continue;
        }
        
        if (peek().value === 'using') {
            consume();
            consume(); // namespace
            const nsName = expect('identifier').value;
            if (peek().value === ';') consume();
            if (!namespaces[nsName]) namespaces[nsName] = { functions: {} };
            continue;
        }
        
        if (peek().type === 'symbol' && peek().value === '#' && tokens[pos + 1] && tokens[pos + 1].value === 'defNS') {
            consume();
            consume();
            const defNsName = expect('identifier').value;
            // 注册命名空间并切换当前命名空间
            if (!namespaces[defNsName]) {
                namespaces[defNsName] = { functions: {} };
            }
            currentNs = defNsName;
            hasDefNS = true;  // 标记
            continue;
        }
        
        const typeKw: Record<string, boolean> = {
            'int': true, 'float': true, 'double': true, 'char': true,
            'string': true, 'bool': true, 'void': true,
            'stack': true, 'queue': true, 'vector': true,
            'pair': true, 'priority_queue': true
        };
        
        if (typeKw[peek().value]) {
            const funcName = tokens[pos + 1];
            if (funcName && funcName.type === 'identifier' && tokens[pos + 2] && tokens[pos + 2].value === '(') {
                const func = parseFunction();
                namespaces[currentNs].functions[func.name] = func;
            } else {
                const stmt = parseStatement();
                globalStmts.push(stmt);
            }
        } else if (peek().value === 'struct') {
            const sd = parseStructDef();
            globalStmts.push(sd);
        } else if (peek().value === 'void' && tokens[pos + 1] && tokens[pos + 1].type === 'identifier' && tokens[pos + 2] && tokens[pos + 2].value === '(') {
            globalStmts.push(parseStatement());
        } else {
            consume();
        }
    }
    
    return { namespaces, globalStmts, namespace: currentNs, hasDefNS: hasDefNS || false };
}

// ============ 执行器 ============
function callFunction(func: any, args: any[], callScope: any, outputs: string[], startTime: number, depth: number = 0): any {
    if (depth > QLANG_MAX_STACK_DEPTH) throw new ScriptError("栈溢出");
    const funcScope = createScope(callScope);
    for (let pi = 0; pi < func.params.length; pi++) {
        const pv = pi < args.length ? args[pi] : 0;
        declareVar(funcScope, func.params[pi].name, pv, func.params[pi].type, false);
    }
    for (let si = 0; si < func.body.length; si++) {
        const r = execStmt(func.body[si], funcScope, outputs, startTime, depth, null);
        if (r && r.type === 'return') return r.value;
    }
    return 0;
}

function execStmt(stmt: any, scope: any, outputs: string[], startTime: number, depth: number, loopEnv: any): any {
    if (Date.now() - startTime > QLANG_TOTAL_TIMEOUT_MS) throw new ScriptError("执行超时");
    if (!stmt) return;

    switch (stmt.type) {
        case 'empty': return;
        case 'block': {
            const blockScope = createScope(scope);
            for (let bi = 0; bi < stmt.body.length; bi++) {
                const rb = execStmt(stmt.body[bi], blockScope, outputs, startTime, depth, loopEnv);
                if (rb && (rb.type === 'return' || rb.type === 'break' || rb.type === 'continue')) return rb;
            }
            return;
        }
        case 'varDecl': {
            const val = stmt.init !== null ? evalExpr(stmt.init, scope, startTime, depth) : defaultValue(stmt.varType);
            declareVar(scope, stmt.name, val, stmt.varType, stmt.isConst);
            return;
        }
        case 'arrayDecl': {
            const size = stmt.size ? evalExpr(stmt.size, scope, startTime, depth) : (stmt.init ? stmt.init.length : 1);
            if (typeof size !== 'number' || size <= 0 || size > QLANG_MAX_ARRAY_SIZE) throw new ScriptError("数组大小无效");
            const arr = new Array(size);
            const dv = defaultValue(stmt.varType);
            for (let ai = 0; ai < size; ai++) {
                arr[ai] = (stmt.init && ai < stmt.init.length)
                    ? evalExpr(stmt.init[ai], scope, startTime, depth)
                    : dv;
            }
            QLANG_MEMORY[allocAddr()] = arr;
            scope.vars[stmt.name] = { addr: QLANG_NEXT_ADDR - 1, type: stmt.varType + '[]', isConst: !!stmt.isConst };
            return;
        }
        case 'assign': {
            setVar(scope, stmt.name, evalExpr(stmt.value, scope, startTime, depth));
            return;
        }
        case 'derefAssign': {
            const derefAddr = getVar(scope, stmt.ptrName);
            if (typeof derefAddr !== 'number') throw new ScriptError("解引用赋值需要指针");
            const derefObj = QLANG_MEMORY[derefAddr];
            if (!derefObj || typeof derefObj !== 'object') throw new ScriptError("无效的指针");
            derefObj[stmt.member] = evalExpr(stmt.value, scope, startTime, depth);
            return;
        }
        case 'arrowAssign': {
            const aPtr = getVar(scope, stmt.ptr);
            if (aPtr === 0) throw new ScriptError("空指针");
            if (typeof aPtr !== 'number') throw new ScriptError("箭头赋值需要指针");
            const aObj = QLANG_MEMORY[aPtr];
            if (!aObj || typeof aObj !== 'object') throw new ScriptError("无效的指针");
            aObj[stmt.member] = evalExpr(stmt.value, scope, startTime, depth);
            return;
        }
        case 'arrAssign': {
            const arr = getVar(scope, stmt.name);
            if (!Array.isArray(arr)) throw new ScriptError("数组 " + stmt.name + " 未定义");
            const idx = evalExpr(stmt.index, scope, startTime, depth);
            const val = evalExpr(stmt.value, scope, startTime, depth);
            if (stmt.op === '=') arr[idx] = val;
            else if (stmt.op === '+=') arr[idx] = (arr[idx] || 0) + val;
            else if (stmt.op === '-=') arr[idx] = (arr[idx] || 0) - val;
            return;
        }
        case 'compAssign': {
            const old = getVar(scope, stmt.name);
            const dv2 = evalExpr(stmt.value, scope, startTime, depth);
            if (stmt.op === '+=') setVar(scope, stmt.name, old + dv2);
            else if (stmt.op === '-=') setVar(scope, stmt.name, old - dv2);
            return;
        }
        case 'memberAssign': {
            const obj = getVar(scope, stmt.obj);
            obj[stmt.member] = evalExpr(stmt.value, scope, startTime, depth);
            return;
        }
        case 'if': {
            const condVal = evalExpr(stmt.cond, scope, startTime, depth);
            if (isTruthy(condVal)) return execStmt(stmt.then, scope, outputs, startTime, depth, loopEnv);
            else if (stmt.else) return execStmt(stmt.else, scope, outputs, startTime, depth, loopEnv);
            return;
        }
        case 'while': {
            let iter = 0;
            const wStart = Date.now();
            while (isTruthy(evalExpr(stmt.cond, scope, startTime, depth))) {
                if (Date.now() - wStart > 10000) throw new ScriptError("while 超时");
                if (++iter > 100000) throw new ScriptError("循环超限");
                const rw = execStmt(stmt.body, scope, outputs, startTime, depth, loopEnv);
                if (rw && rw.type === 'return') return rw;
                if (rw && rw.type === 'break') break;
            }
            return;
        }
        case 'for': {
            const forScope = createScope(scope);
            if (stmt.init) execStmt(stmt.init, forScope, outputs, startTime, depth, null);
            let iterF = 0;
            const fStart = Date.now();
            while (!stmt.cond || isTruthy(evalExpr(stmt.cond, forScope, startTime, depth))) {
                if (Date.now() - fStart > 10000) throw new ScriptError("for 超时");
                if (++iterF > 100000) throw new ScriptError("循环超限");
                const rf = execStmt(stmt.body, forScope, outputs, startTime, depth, null);
                if (rf && rf.type === 'return') return rf;
                if (rf && rf.type === 'break') break;
                if (stmt.inc) {
                    if (stmt.inc.type === 'forInc') {
                        const oldF = getVar(forScope, stmt.inc.name);
                        const d = evalExpr(stmt.inc.value, forScope, startTime, depth);
                        if (stmt.inc.op === '=') setVar(forScope, stmt.inc.name, d);
                        else if (stmt.inc.op === '+=') setVar(forScope, stmt.inc.name, oldF + d);
                        else if (stmt.inc.op === '-=') setVar(forScope, stmt.inc.name, oldF - d);
                    } else {
                        evalExpr(stmt.inc, forScope, startTime, depth);
                    }
                }
            }
            return;
        }
        case 'function': {
            stmt.parentScope = scope;
            if (globalEnv && globalEnv['__ast__']) {
                const ns4 = globalEnv['__namespace__'] || 'qlgstd';
                if (!globalEnv['__ast__'].namespaces) globalEnv['__ast__'].namespaces = {};
                if (!globalEnv['__ast__'].namespaces[ns4]) globalEnv['__ast__'].namespaces[ns4] = { functions: {} };
                globalEnv['__ast__'].namespaces[ns4].functions[stmt.name] = stmt;
            }
            return;
        }
        case 'return': {
            const retVal = stmt.value !== null ? evalExpr(stmt.value, scope, startTime, depth) : 0;
            return { type: 'return', value: retVal };
        }
        case 'break': return { type: 'break' };
        case 'continue': return { type: 'continue' };
        case 'print': {
            const parts = [];
            for (let pri = 0; pri < stmt.args.length; pri++) {
                parts.push(stringify(evalExpr(stmt.args[pri], scope, startTime, depth)));
            }
            outputs.push(parts.join(' '));
            return;
        }
        case 'cout': {
            let result = '';
            for (let ci = 0; ci < stmt.parts.length; ci++) {
                const part = stmt.parts[ci];
                if (part.type === 'endl') { result += '\n'; continue; }
                result += stringify(evalExpr(part, scope, startTime, depth));
            }
            outputs.push(result);
            return;
        }
        case 'expr': {
            evalExpr(stmt.expr, scope, startTime, depth);
            return;
        }
        case 'phpVarDecl': {
            setVar(scope, stmt.name, evalExpr(stmt.init, scope, startTime, depth));
            return;
        }
        case 'structDef': {
            if (!globalEnv['__structs__']) globalEnv['__structs__'] = {};
            globalEnv['__structs__'][stmt.structName] = stmt;
            return;
        }
        case 'tryCatch': {
            try {
                for (let tsi = 0; tsi < stmt.tryBody.length; tsi++) {
                    const tr = execStmt(stmt.tryBody[tsi], scope, outputs, startTime, depth, null);
                    if (tr && (tr.type === 'return' || tr.type === 'break' || tr.type === 'continue')) return tr;
                }
            } catch (e: any) {
                const errMsg = e instanceof ScriptError ? e.message : String(e.message || e);
                const catchScope = createScope(scope);
                declareVar(catchScope, stmt.catchVar, errMsg, 'string', false);
                for (let csi = 0; csi < stmt.catchBody.length; csi++) {
                    const cr = execStmt(stmt.catchBody[csi], catchScope, outputs, startTime, depth, null);
                    if (cr && (cr.type === 'return' || cr.type === 'break' || cr.type === 'continue')) return cr;
                }
            }
            return;
        }
        case 'throw': {
            const throwVal = evalExpr(stmt.value, scope, startTime, depth);
            throw new ScriptError(String(throwVal));
        }
        default:
            throw new ScriptError("不支持的语句: " + stmt.type);
    }
}

function evalExpr(expr: any, scope: any, startTime: number, depth: number): any {
    if (!expr || typeof expr !== 'object') return expr;

    switch (expr.type) {
        case 'literal': return expr.value;
        case 'number': return parseFloat(expr.value);
        case 'string': return expr.value;
        case 'variable': return getVar(scope, expr.name);
        case 'phpVar': return getVar(scope, expr.value);
        case 'unary': {
            const v = evalExpr(expr.arg || expr.expr, scope, startTime, depth);
            if (expr.op === '-') return -v;
            if (expr.op === '!') return !isTruthy(v);
            if (expr.op === '++') { const nv = v + 1; setVar(scope, expr.arg.name, nv); return nv; }
            if (expr.op === '--') { const nv2 = v - 1; setVar(scope, expr.arg.name, nv2); return nv2; }
            return v;
        }
        case 'postInc': {
            const ov = getVar(scope, expr.name);
            setVar(scope, expr.name, ov + 1);
            return ov;
        }
        case 'postDec': {
            const ov2 = getVar(scope, expr.name);
            setVar(scope, expr.name, ov2 - 1);
            return ov2;
        }
        case 'binary': {
            const l = evalExpr(expr.left, scope, startTime, depth);
            const r = evalExpr(expr.right, scope, startTime, depth);
            switch (expr.op) {
                case '+': return (typeof l === 'string' || typeof r === 'string') ? String(l) + String(r) : (l || 0) + (r || 0);
                case '-': return (l || 0) - (r || 0);
                case '*': return (l || 0) * (r || 0);
                case '/': if (r === 0) throw new ScriptError("除零"); return Math.floor(l / r);
                case '%': return l % r;
                case '==': return l == r;
                case '!=': return l != r;
                case '<': return l < r;
                case '>': return l > r;
                case '<=': return l <= r;
                case '>=': return l >= r;
                case '&&': case 'and': return isTruthy(l) && isTruthy(r);
                case '||': case 'or': return isTruthy(l) || isTruthy(r);
                default: return 0;
            }
        }
        case 'call': return handleCall(expr, scope, startTime, depth);
        case 'methodCall': {
            const objV = getVar(scope, expr.obj);
            const method = objV[expr.method];
            if (typeof method !== 'function') throw new ScriptError("方法 " + expr.method + " 不存在");
            const mArgs = [];
            for (let mi = 0; mi < expr.args.length; mi++) mArgs.push(evalExpr(expr.args[mi], scope, startTime, depth));
            return method.apply(objV, mArgs);
        }
        case 'memberAccess': {
            const o = expr.base ? evalExpr(expr.base, scope, startTime, depth) : getVar(scope, expr.obj);
            if (o === null || o === undefined) throw new ScriptError("对象 " + (expr.obj || 'expr') + " 未定义");
            return o[expr.member];
        }
        case 'arrayAccess': {
            const arr = getVar(scope, expr.name);
            const idx = evalExpr(expr.index, scope, startTime, depth);
            if (expr.index2) {
                const idx2 = evalExpr(expr.index2, scope, startTime, depth);
                return arr[idx][idx2];
            }
            return arr[idx];
        }
        case 'newExpr': {
            return handleNewExpr(expr, scope, startTime, depth);
        }
        case 'arrowAccess2': {
            const baseVal = evalExpr(expr.base, scope, startTime, depth);
            if (baseVal === 0) throw new ScriptError("空指针");
            if (typeof baseVal !== 'number') throw new ScriptError("箭头访问需要指针");
            const obj3 = QLANG_MEMORY[baseVal];
            if (!obj3 || typeof obj3 !== 'object') throw new ScriptError("无效的指针");
            return obj3[expr.member];
        }
        case 'addrOf': {
            return addrOf(scope, expr.name);
        }
        case 'deref': {
            const ptrAddr = evalExpr(expr.expr, scope, startTime, depth);
            if (ptrAddr === 0 || ptrAddr === null || ptrAddr === undefined) throw new ScriptError("空指针");
            if (typeof ptrAddr !== 'number' || ptrAddr < 0 || ptrAddr >= QLANG_MEMORY_SIZE) throw new ScriptError("无效的指针地址");
            return QLANG_MEMORY[ptrAddr];
        }
        case 'arrowAccess': {
            const ptrAddr = getVar(scope, expr.ptr);
            if (ptrAddr === 0) throw new ScriptError("空指针");
            if (typeof ptrAddr !== 'number') throw new ScriptError("箭头访问需要指针");
            const obj = QLANG_MEMORY[ptrAddr];
            if (!obj || typeof obj !== 'object') throw new ScriptError("无效的指针");
            return obj[expr.member];
        }
        case 'arrowCall': {
            const ptrAddr2 = getVar(scope, expr.ptr);
            if (typeof ptrAddr2 !== 'number') throw new ScriptError("箭头方法调用需要指针");
            const obj2 = QLANG_MEMORY[ptrAddr2];
            if (!obj2 || typeof obj2 !== 'object') throw new ScriptError("无效的指针");
            const method = obj2[expr.method];
            if (typeof method !== 'function') throw new ScriptError("方法 " + expr.method + " 不存在");
            const aArgs = [];
            for (let ami = 0; ami < expr.args.length; ami++) aArgs.push(evalExpr(expr.args[ami], scope, startTime, depth));
            return method.apply(obj2, aArgs);
        }
        default:
            throw new ScriptError("不支持的表达式: " + expr.type);
    }
}

function handleCall(expr: any, scope: any, startTime: number, depth: number): any {
    // 内置函数
    if (expr.name === '_gcd') {
        let a = Math.abs(evalExpr(expr.args[0], scope, startTime, depth));
        let b = Math.abs(evalExpr(expr.args[1], scope, startTime, depth));
        while (b) { const t = b; b = a % b; a = t; }
        return a;
    }
    if (expr.name === 'parseInt') {
        return parseInt(String(evalExpr(expr.args[0], scope, startTime, depth))) || 0;
    }
    if (expr.name === 'sizeof') {
        const sv = evalExpr(expr.args[0], scope, startTime, depth);
        return Array.isArray(sv) ? sv.length : (typeof sv === 'string' ? sv.length : 0);
    }
    if (expr.name === 'size') {
        const sv2 = evalExpr(expr.args[0], scope, startTime, depth);
        if (sv2 && typeof sv2.size === 'function') return sv2.size();
        if (Array.isArray(sv2)) return sv2.length;
        return 0;
    }
    if (expr.name === 'strlen') {
        const sl = evalExpr(expr.args[0], scope, startTime, depth);
        return typeof sl === 'string' ? sl.length : (Array.isArray(sl) ? sl.indexOf('\0') >= 0 ? sl.indexOf('\0') : sl.length : 0);
    }
    if (expr.name === 'printf') {
        const fmt = String(evalExpr(expr.args[0], scope, startTime, depth));
        const pArgs = [];
        for (let pa = 1; pa < expr.args.length; pa++) pArgs.push(evalExpr(expr.args[pa], scope, startTime, depth));
        const out = printfFormat(fmt, pArgs);
        globalEnv['__outputs__'].push(out);
        return pArgs.length;
    }
    if (expr.name === 'abort') {
        const abortMsg = expr.args.length > 0 ? String(evalExpr(expr.args[0], scope, startTime, depth)) : 'abort';
        throw new ScriptError("abort: " + abortMsg);
    }
    
    // 自定义函数
    if (globalEnv['__ast__']) {
        const ns3 = expr.namespace || (globalEnv['__namespace__'] || 'qlgstd');
        const funcs = globalEnv['__ast__'].namespaces && globalEnv['__ast__'].namespaces[ns3] && globalEnv['__ast__'].namespaces[ns3].functions;
        if (funcs && funcs[expr.name]) {
            const func = funcs[expr.name];
            const funcArgs = [];
            for (let ai = 0; ai < expr.args.length; ai++) {
                funcArgs.push(evalExpr(expr.args[ai], scope, startTime, depth));
            }
            return callFunction(func, funcArgs, scope, globalEnv['__outputs__'], startTime, depth + 1);
        }
    }
    throw new ScriptError((expr.line ? '第' + expr.line + '行: ' : '') + "未定义函数: " + expr.name + " (可用命名空间: " + Object.keys(globalEnv['__ast__'].namespaces).join(',') + ")");
}

function handleNewExpr(expr: any, scope: any, startTime: number, depth: number): number {
    if (!globalEnv['__structs__'] || !globalEnv['__structs__'][expr.structType]) {
        throw new ScriptError("未定义的结构体: " + expr.structType);
    }
    const structDef = globalEnv['__structs__'][expr.structType];
    const initArgs = [];
    for (let ni = 0; ni < expr.args.length; ni++) {
        initArgs.push(evalExpr(expr.args[ni], scope, startTime, depth));
    }
    const addr = allocAddr();
    const obj: any = {};
    for (let fi = 0; fi < structDef.fields.length; fi++) {
        const f = structDef.fields[fi];
        obj[f.name] = fi < initArgs.length ? initArgs[fi] : 0;
    }
    obj.__addr = addr;
    QLANG_MEMORY[addr] = obj;
    return addr;
}

// ============ 全局环境 ============
let globalEnv: any = {};

// ============ 执行主入口 ============
function execute(ast: ParseResult, answers: Record<string, string>, otherInputs: any, qs: any[]): string {
    QLANG_MEMORY = new Array(QLANG_MEMORY_SIZE);
    QLANG_NEXT_ADDR = 1;
    QLANG_SCOPE_ID = 0;
    const ns2 = 'qlgstd';
    if (!ast.namespaces || !ast.namespaces[ns2] || !ast.namespaces[ns2].functions['main']) {
        throw new ScriptError("未找到 main()");
    }
    const rootScope = createScope(null);
    const outputs: string[] = [];
    const startTime = Date.now();

    // 注入 qid 数据
    let qidAddr: number | undefined;
    if (answers && qs) {
        const qidTypeMap: Record<string, string> = {};
        for (let _qmi = 0; _qmi < qs.length; _qmi++) {
            const _q = qs[_qmi];
            if (_q.type !== 'section' && _q.id) {
                qidTypeMap[_q.id] = _q.type;
            }
        }
        const qidObj: any = {};
        for (const qid in answers) {
            const ans = answers[qid];
            const qtype = qidTypeMap[qid] || 'text';
            let textVal = '';
            let numVal = -1;
            if (qtype === 'text' || qtype === 'textarea') {
                textVal = String(ans);
                if (qtype === 'textarea') {
                    textVal = textVal.replace(/\n/g, '\\n');
                }
                numVal = -1;
            } else if (qtype === 'single') {
                textVal = String(ans);
                numVal = 1;
            } else if (qtype === 'multiple') {
                if (Array.isArray(ans)) {
                    textVal = ans.join(' ');
                    numVal = ans.length;
                } else {
                    textVal = String(ans);
                    numVal = 1;
                }
            } else if (qtype === 'rating' || qtype === 'likert' || qtype === 'nps') {
                numVal = parseInt(ans);
                if (isNaN(numVal)) numVal = -1;
                textVal = String(numVal);
            } else if (qtype === 'time') {
                textVal = String(ans);
                const tp = String(ans).split(':');
                if (tp.length >= 3) {
                    const hh = parseInt(tp[0]) || 0;
                    const mm = parseInt(tp[1]) || 0;
                    const ss = parseInt(tp[2]) || 0;
                    numVal = hh * 3600 + mm * 60 + ss;
                } else if (tp.length === 2) {
                    const hh2 = parseInt(tp[0]) || 0;
                    const mm2 = parseInt(tp[1]) || 0;
                    numVal = hh2 * 3600 + mm2 * 60;
                } else {
                    numVal = -1;
                }
            } else {
                textVal = String(ans);
                numVal = -1;
            }
            qidObj[qid + '_num'] = numVal;
            qidObj[qid + '_text'] = textVal;
        }
        qidAddr = allocAddr();
        qidObj.__addr = qidAddr;
        QLANG_MEMORY[qidAddr] = qidObj;
    }

    globalEnv.__ast__ = ast;
    globalEnv.__outputs__ = outputs;
    globalEnv.__startTime__ = startTime;
    globalEnv.__namespace__ = ns2;
    
    for (let gi = 0; gi < ast.globalStmts.length; gi++) {
        execStmt(ast.globalStmts[gi], rootScope, outputs, startTime, 0, null);
    }
    const mainArgs = (typeof qidAddr !== 'undefined') ? [qidAddr] : [];
    callFunction(ast.namespaces[ns2].functions['main'], mainArgs, rootScope, outputs, startTime, 0);

    if (outputs.length > 0) return '\n\n── 结果 ──\n' + outputs.join('\n');
    return '';
}

// ============ 主入口函数 ============
export async function executeQLang(
    resultCodeStr: string,
    answers: Record<string, string>,
    otherInputs: any,
    qs: any[]
): Promise<string> {
    try {
        // 预处理：收集 #include 指令
        const includes: { name: string; ph: string }[] = [];
        let incIdx = 0;
        resultCodeStr = resultCodeStr.replace(/^#include\s*<([^>]+)>/gm, function(m, libName) {
            const ph = "___QLIB_" + (incIdx++) + "___";
            includes.push({ name: libName, ph: ph });
            return ph;
        });
        
        // 解析库文件
        const libAsts: Record<string, ParseResult> = {};
        let libCode = '';
        for (let ii = 0; ii < includes.length; ii++) {
            try {
                const libCode = readLibraryFileSync(includes[ii].name);
                if (!libCode || !libCode.trim()) throw new Error("空内容");
                const subAst = parse(libCode);
                libAsts[includes[ii].name] = subAst;
            } catch (e) {
                const err = e instanceof ScriptError ? e : new ScriptError(String(e));
                let libErr = err.message || "读取失败";
                const libLineMatch = String(libErr).match(/第(\d+)行:/);
                if (libLineMatch) {
                    const libLn = parseInt(libLineMatch[1]);
                    const libSrcLines = libCode.split('\n');
                    const libLineContent = (libLn >= 1 && libLn <= libSrcLines.length) ? libSrcLines[libLn - 1].trim() : '';
                    libErr += '\n  → ' + libLineContent;
                }
                throw new ScriptError("[库: " + includes[ii].name + ".qlg] " + libErr);
            }
            resultCodeStr = resultCodeStr.replace(includes[ii].ph, "");
        }
        
        // 解析主代码
        const ast = parse(resultCodeStr, libAsts);
        if (!ast.namespaces) ast.namespaces = {};
        
        // 检查 #defNS（主文件禁止）
        const defNSMatch = resultCodeStr.match(/^#defNS\s+(\w+)/m);
        if (defNSMatch) {
            throw new ScriptError("主代码中不允许使用 #defNS，该指令仅用于外部 .qlg 库文件");
        }
        
        // 处理 using namespace
        const usingNSMatches = resultCodeStr.match(/^using\s+namespace\s+(\w+)/gm);
        let currentNs = 'qlgstd';
        if (usingNSMatches) {
            for (let umi = 0; umi < usingNSMatches.length; umi++) {
                const um = usingNSMatches[umi];
                const umName = um.match(/^using\s+namespace\s+(\w+)/)![1];
                resultCodeStr = resultCodeStr.replace(um, "");
                if (ast.namespaces && ast.namespaces[umName]) {
                    const targetNs = ast.namespaces['qlgstd'];
                    const srcNs = ast.namespaces[umName];
                    for (const fn in srcNs.functions) {
                        if (!targetNs.functions[fn]) {
                            targetNs.functions[fn] = srcNs.functions[fn];
                        }
                    }
                }
            }
            currentNs = 'qlgstd';
        }
        
        ast.namespace = currentNs;
        return execute(ast, answers, otherInputs, qs);
    } catch (e: any) {
        let errMsg = e instanceof ScriptError ? e.message : String(e.message || e);
        if (errMsg.indexOf('[库:') >= 0) {
            throw new ScriptError(errMsg);
        }
        const lineMatch = String(errMsg).match(/第(\d+)行:/);
        if (lineMatch) {
            const ln = parseInt(lineMatch[1]);
            const srcLines = resultCodeStr.split('\n');
            const lineContent = (ln >= 1 && ln <= srcLines.length) ? srcLines[ln - 1].trim() : '';
            errMsg = '[文件: 入口程序] ' + errMsg + '\n  → ' + lineContent;
        } else {
            errMsg = '[文件: 入口程序] ' + errMsg;
        }
        throw new ScriptError(errMsg);
    }
}