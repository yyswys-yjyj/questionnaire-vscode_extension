// QLangParser — 语法分析 + AST 生成
// @ts-nocheck

import { tokenize } from './QLangTokenizer';
import { isTypeLike, resolveType } from './QLangTypes';
import * as fs from 'fs';
import * as path from 'path';

let _currentWorkingDir: string = process.cwd();

export function setParserWorkingDir(dir: string): void {
    _currentWorkingDir = dir;
}

export function ScriptError(msg) {
    this.message = '脚本错误: ' + msg;
}
ScriptError.prototype = Object.create(Error.prototype);
ScriptError.prototype.constructor = ScriptError;

// 解析器：从 Token 流构建 AST
export function parse(code, extraAsts) {
    var tokens = tokenize(code);
    var pos = 0;
    var structTypeNames = {};
    var typeAliases = {};

    function peek() { return pos < tokens.length ? tokens[pos] : { type: 'eof', value: '' }; }
    function consume() { return pos < tokens.length ? tokens[pos++] : { type: 'eof', value: '' }; }
    function expect(type, value) {
        var t = consume();
        if (t.type !== type || (value !== undefined && t.value !== value)) {
            throw new ScriptError('第' + (t.line || '?') + '行: 期望 ' + (value || type) + '，得到 ' + t.value);
        }
        return t;
    }

    // 解析函数定义
    function parseFunction() {
        var returnType = resolveType(consume().value, typeAliases);
        var name = expect('identifier').value;
        expect('symbol', '(');
        var params = [];
        while (peek().value !== ')') {
            var pType = resolveType(consume().value, typeAliases);
            if (peek().value === '[') { consume(); expect('symbol', ']'); pType += '[]'; }
            var isRef = false;
            if (peek().value === '&') { isRef = true; consume(); }
            var pName = expect('identifier').value;
            if (peek().value === '[') { consume(); expect('symbol', ']'); pType += '[]'; }
            params.push({ type: pType, name: pName, isRef: isRef });
            if (peek().value === ',') consume();
        }
        expect('symbol', ')');
        expect('symbol', '{');
        var body = parseBlock();
        return { type: 'function', returnType: returnType, name: name, params: params, body: body };
    }

    // 解析结构体定义
    function parseStructDef() {
        consume(); // struct
        var name = expect('identifier').value;
        structTypeNames[name] = true;
        expect('symbol', '{');
        var fields = [];
        while (peek().value !== '}') {
            var ft = consume().value;
            var fn = expect('identifier').value;
            expect('symbol', ';');
            fields.push({ type: ft, name: fn });
        }
        expect('symbol', '}');
        expect('symbol', ';');
        return { type: 'structDef', structName: name, fields: fields };
    }

    // 解析语句块
    function parseBlock() {
        var stmts = [];
        while (peek().value !== '}' && peek().type !== 'eof') {
            stmts.push(parseStatement());
        }
        if (peek().value === '}') consume();
        return stmts;
    }

    // 解析语句
    function parseStatement() {
        if (peek().value === ';') { consume(); return { type: 'empty' }; }
        if (peek().value === '{') {
            consume();
            var body = parseBlock();
            return { type: 'block', body: body };
        }

        function looksLikeFunc(p) {
            var i = p;
            if (peek().value === 'void') { i += 1; } else { i += 2; }
            if (i < tokens.length && tokens[i].value === '(') return true;
            while (i < tokens.length && tokens[i].value !== '(' && tokens[i].value !== '{' && tokens[i].value !== ';' && tokens[i].value !== '=') i++;
            return i < tokens.length && tokens[i].value === '(';
        }
        var isFuncDef = false;
        if (peek().value === 'void' || isTypeLike(peek().value, typeAliases)) {
            if (tokens[pos + 1] && tokens[pos + 1].type === 'identifier' && looksLikeFunc(pos)) {
                isFuncDef = true;
            }
        }
        if (isFuncDef) return parseFunction();

        if (isTypeLike(peek().value, typeAliases) || (peek().value === 'const' && tokens[pos + 1] && isTypeLike(tokens[pos + 1].value, typeAliases))) {
            return parseVarDecl();
        }

        // 结构体指针变量声明
        if (peek().type === 'identifier' && tokens[pos + 1] && tokens[pos + 1].value === '*' && tokens[pos + 2] && tokens[pos + 2].type === 'identifier') {
            return parseStructPtrDecl();
        }
        if (peek().type === 'identifier' && tokens[pos + 1] && tokens[pos + 1].type === 'identifier' && structTypeNames[peek().value]) {
            return parseStructPtrDecl(false);
        }
        if (peek().value === 'struct') return parseStructDef();

        // typedef / #define
        if (peek().value === 'typedef') { consume(); var _s = peek().value; consume(); var _d = expect('identifier').value; expect('symbol', ';'); typeAliases[_d] = _s; return { type: 'empty' }; }
        if (peek().type === 'define') { var _dt = consume(); typeAliases[_dt.name] = _dt.value; return { type: 'empty' }; }

        // PHP风格变量
        if (peek().type === 'phpVar' && tokens[pos + 1] && tokens[pos + 1].value === '=') {
            return parsePhpVarDecl();
        }

        // 关键字
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
        if (peek().value === 'setap') { consume(); var _l = consume(); expect('symbol', ';'); return { type: 'setap', label: _l.value }; }
        if (peek().value === 'gotoap') { consume(); var _l2 = consume(); expect('symbol', ';'); return { type: 'gotoap', label: _l2.value }; }
        // #gc 指令
        if (peek().type === 'gc') { var _gcTok = consume(); return { type: 'gc', varName: _gcTok.varName }; }
        // @ 指令（已迁移至 QinitCode，QLang 中忽略）
        if (peek().type === 'atDirective') {
            consume(); // 跳过 @ 指令
            // 尝试跳过参数和块
            if (peek().value === '(') {
                var _depth = 1;
                consume();
                while (_depth > 0 && peek().type !== 'eof') {
                    if (peek().value === '(') _depth++;
                    else if (peek().value === ')') _depth--;
                    consume();
                }
            }
            // 跳过直到下一个分号或块
            while (peek().value !== ';' && peek().value !== '{' && peek().type !== 'eof' && peek().value !== '\n') consume();
            if (peek().value === ';') consume();
            if (peek().value === '{') parseBlock(); // 跳过块
            return { type: 'empty' };
        }
return parseExpressionStmt();
    }

    function parseTryCatch() {
        consume(); // try
        expect('symbol', '{');
        var tryBody = parseBlock();
        var cToken = consume();
        if (cToken.value !== 'catch') throw new ScriptError('期望 catch');
        expect('symbol', '(');
        var catchVar = expect('identifier').value;
        expect('symbol', ')');
        expect('symbol', '{');
        var catchBody = parseBlock();
        return { type: 'tryCatch', tryBody: tryBody, catchVar: catchVar, catchBody: catchBody };
    }

    function parseThrow() {
        consume();
        var val = parseExpression();
        expect('symbol', ';');
        return { type: 'throw', value: val };
    }

    function parsePhpVarDecl() {
        var name = consume().value;
        consume(); // =
        var init = parseExpression();
        expect('symbol', ';');
        return { type: 'phpVarDecl', name: name, init: init };
    }

    function parseStructPtrDecl(isPtr) {
        if (isPtr === undefined) isPtr = true;
        var typeName = consume().value;
        if (isPtr) consume();
        var name = expect('identifier').value;
        var init = null;
        if (peek().value === '=') { consume(); init = parseExpression(); }
        expect('symbol', ';');
        return { type: 'varDecl', varType: typeName + (isPtr ? '*' : ''), name: name, init: init, isConst: false };
    }

    function parseVarDecl() {
        var isConst = false;
        if (peek().value === 'const') { isConst = true; consume(); }
        var type = resolveType(consume().value, typeAliases);
        var isPtr = false;
        if (peek().value === '*') { isPtr = true; consume(); }
        else if (peek().type === 'operator' && peek().value === '*') { isPtr = true; consume(); }
        var name = expect('identifier').value;
        var init = null;
        if (peek().value === '[') {
            consume();
            var sizeExpr1 = null;
            if (peek().value !== ']') sizeExpr1 = parseExpression();
            expect('symbol', ']');
            var sizeExpr2 = null;
            if (peek().value === '[') {
                consume();
                if (peek().value !== ']') sizeExpr2 = parseExpression();
                expect('symbol', ']');
            }
            var initArr = null;
            var initStr = null;
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
                return { type: 'arrayDecl2D', varType: type, name: name, size1: sizeExpr1, size2: sizeExpr2, init: initArr, isConst: isConst };
            }
            return { type: 'arrayDecl', varType: type, name: name, size: sizeExpr1, init: initArr, initStr: initStr, isConst: isConst };
        }
        if (peek().value === '=') { consume(); init = parseExpression(); }
        expect('symbol', ';');
        return { type: 'varDecl', varType: type, name: name, init: init, isConst: isConst };
    }

    function parseArrayInit() {
        var values = [];
        while (peek().value !== '}') {
            if (peek().value === '{') { consume(); values.push(parseArrayInit()); }
            else { values.push(parseExpression()); }
            if (peek().value === ',') consume();
        }
        expect('symbol', '}');
        return values;
    }

    function parseIf() {
        consume();
        expect('symbol', '(');
        var cond = parseExpression();
        expect('symbol', ')');
        var then = parseStatement();
        var elseStmt = null;
        if (peek().value === 'else') { consume(); elseStmt = parseStatement(); }
        return { type: 'if', cond: cond, then: then, else: elseStmt };
    }

    function parseWhile() {
        consume();
        expect('symbol', '(');
        var cond = parseExpression();
        expect('symbol', ')');
        var body = parseStatement();
        return { type: 'while', cond: cond, body: body };
    }

    function parseFor() {
        consume();
        expect('symbol', '(');
        var init = null;
        if (peek().value !== ';') {
            if (peek().type === 'phpVar' && tokens[pos + 1] && tokens[pos + 1].value === '=') {
                var pName = consume().value;
                consume();
                init = { type: 'phpVarDecl', name: pName, init: parseExpression() };
            } else if (peek().type === 'identifier' && tokens[pos + 1] && (tokens[pos + 1].value === '=' || tokens[pos + 1].value === '+=' || tokens[pos + 1].value === '-=')) {
                var iName = consume().value;
                var iOp = consume().value;
                init = { type: 'assign', name: iName, value: parseExpression() };
            } else {
                init = parseStatementPart();
            }
        }
        expect('symbol', ';');
        var cond = null;
        if (peek().value !== ';') cond = parseExpression();
        expect('symbol', ';');
        var inc = null;
        if (peek().value !== ')') {
            if (peek().type === 'identifier' && tokens[pos + 1] && (tokens[pos + 1].value === '=' || tokens[pos + 1].value === '+=' || tokens[pos + 1].value === '-=')) {
                var incName = consume().value;
                var incOp = consume().value;
                inc = { type: 'forInc', name: incName, op: incOp, value: parseExpression() };
            } else {
                inc = parseExpression();
            }
        }
        expect('symbol', ')');
        var body = parseStatement();
        return { type: 'for', init: init, cond: cond, inc: inc, body: body };
    }

    function parseReturn() {
        consume();
        var value = null;
        if (peek().value !== ';') value = parseExpression();
        expect('symbol', ';');
        return { type: 'return', value: value };
    }

    function parseCout() {
        consume();
        expect('operator', '<<');
        var parts = [];
        while (peek().value !== ';') {
            if (peek().value === 'endl') { consume(); parts.push({ type: 'endl' }); }
            else { parts.push(parseExpression()); }
            if (peek().value === '<<') consume();
        }
        expect('symbol', ';');
        return { type: 'cout', parts: parts };
    }

    function parsePrint() {
        consume();
        expect('symbol', '(');
        var args = [];
        while (peek().value !== ')') {
            args.push(parseExpression());
            if (peek().value === ',') consume();
        }
        expect('symbol', ')');
        expect('symbol', ';');
        return { type: 'print', args: args };
    }

    function parseStatementPart() {
        if (isTypeLike(peek().value, typeAliases)) {
            var type = consume().value;
            var name = expect('identifier').value;
            var init = null;
            if (peek().value === '=') { consume(); init = parseExpression(); }
            return { type: 'varDecl', varType: type, name: name, init: init };
        }
        return parseExpression();
    }

    function parseExpressionStmt() {
        if (peek().type === 'identifier' && tokens[pos + 1]) {
            var lookAhead = tokens[pos + 1].value;
            if (lookAhead === '[') {
                var arrName = consume().value;
                consume();
                var arrIdx = parseExpression();
                expect('symbol', ']');
                if (peek().value === '=' || peek().value === '+=' || peek().value === '-=') {
                    var arrOp = consume().value;
                    var arrVal = parseExpression();
                    expect('symbol', ';');
                    return { type: 'arrAssign', name: arrName, index: arrIdx, op: arrOp, value: arrVal };
                }
                pos = pos - 3;
                var expr = parseExpression();
                expect('symbol', ';');
                return { type: 'expr', expr: expr };
            }
            if (lookAhead === '=' && tokens[pos + 2] && tokens[pos + 2].value !== '=') {
                var name = consume().value;
                consume();
                var value = parseExpression();
                expect('symbol', ';');
                return { type: 'assign', name: name, value: value };
            }
            if (lookAhead === '+=' || lookAhead === '-=') {
                var name2 = consume().value;
                var op = consume().value;
                var value2 = parseExpression();
                expect('symbol', ';');
                return { type: 'compAssign', name: name2, op: op, value: value2 };
            }
            if (lookAhead === '.' && tokens[pos + 2] && tokens[pos + 3] && (tokens[pos + 3].value === '=')) {
                var objName = consume().value;
                consume();
                var memberName = expect('identifier').value;
                consume();
                var value3 = parseExpression();
                expect('symbol', ';');
                return { type: 'memberAssign', obj: objName, member: memberName, value: value3 };
            }
            if (tokens[pos + 1] && tokens[pos + 1].type === 'operator' && tokens[pos + 1].value === '->' && tokens[pos + 2] && tokens[pos + 3] && tokens[pos + 3].value === '=') {
                var ptrName = consume().value;
                consume();
                var arrowMember = expect('identifier').value;
                consume();
                var value4 = parseExpression();
                expect('symbol', ';');
                return { type: 'arrowAssign', ptr: ptrName, member: arrowMember, value: value4 };
            }
        }
        // (*ptr).member = expr
        if (peek().value === '(') {
            var savedPos = pos;
            consume();
            if (peek().value === '*') {
                consume();
                if (peek().type === 'identifier') {
                    var derefName = consume().value;
                    if (peek().value === ')') {
                        consume();
                        if (peek().value === '.' && tokens[pos + 1] && tokens[pos + 2] && tokens[pos + 2].value === '=') {
                            consume();
                            var dMemberName = expect('identifier').value;
                            consume();
                            var dValue = parseExpression();
                            expect('symbol', ';');
                            return { type: 'derefAssign', ptrName: derefName, member: dMemberName, value: dValue };
                        }
                    }
                }
            }
            pos = savedPos;
        }
        var expr = parseExpression();
        expect('symbol', ';');
        return { type: 'expr', expr: expr };
    }

    // === 表达式解析 ===
    function parseExpression() { _curLine = peek().line || 1; return parseTernary(); }
    function parseTernary() {
        var left = parseLogic();
        if (peek().value === '?') {
            consume();
            var trueExpr = parseExpression();
            expect('symbol', ':');
            var falseExpr = parseExpression();
            return { type: 'ternary', cond: left, trueExpr: trueExpr, falseExpr: falseExpr, line: _curLine };
        }
        return left;
    }
    function parseLogic() {
        var left = parseCompare();
        while (peek().value === '&&' || peek().value === '||' || peek().value === 'and' || peek().value === 'or') {
            var op = consume().value;
            var right = parseCompare();
            left = { type: 'binary', op: op, left: left, right: right, line: _curLine };
        }
        return left;
    }
    var _curLine = 1;
    var cmpOps = { '>': true, '<': true, '>=': true, '<=': true, '==': true, '!=': true };
    function parseCompare() {
        var left = parseBitOr();
        var op = peek().value;
        var nextOp = op + tokens[pos + 1]?.value || '';
        // 排除 >> 和 <<（它们在 parseShift 中处理，优先级更低）
        if (nextOp === '>>' || nextOp === '<<') return left;
        if (cmpOps[op] || cmpOps[nextOp]) {
            if (cmpOps[nextOp]) { op = nextOp; consume(); }
            consume();
            var right = parseBitOr();
            return { type: 'binary', op: op, left: left, right: right, line: _curLine };
        }
        return left;
    }
    function parseBitOr() {
        var left = parseBitXor();
        while (peek().value === '|') {
            var op = consume().value;
            var right = parseBitXor();
            left = { type: 'binary', op: op, left: left, right: right, line: _curLine };
        }
        return left;
    }
    function parseBitXor() {
        var left = parseBitAnd();
        while (peek().value === '^') {
            var op = consume().value;
            var right = parseBitAnd();
            left = { type: 'binary', op: op, left: left, right: right, line: _curLine };
        }
        return left;
    }
    function parseBitAnd() {
        var left = parseShift();
        while (peek().value === '&') {
            var op = consume().value;
            var right = parseShift();
            left = { type: 'binary', op: op, left: left, right: right, line: _curLine };
        }
        return left;
    }
    function parseShift() {
        var left = parseAddSub();
        var next = peek().value + (tokens[pos + 1]?.value || '');
        while (next === '<<' || next === '>>') {
            var op = next;
            consume(); consume();
            var right = parseAddSub();
            left = { type: 'binary', op: op, left: left, right: right, line: _curLine };
            next = peek().value + (tokens[pos + 1]?.value || '');
        }
        // 如果当前 token 本身就是 >> 或 <<（单 token 操作符）
        var op2 = peek().value;
        if (op2 === '>>' || op2 === '<<') {
            consume();
            var right2 = parseAddSub();
            return { type: 'binary', op: op2, left: left, right: right2 };
        }
        return left;
    }
    function parseAddSub() {
        var left = parseMulDiv();
        while (peek().value === '+' || peek().value === '-') {
            var op = consume().value;
            var right = parseMulDiv();
            left = { type: 'binary', op: op, left: left, right: right, line: _curLine };
        }
        return left;
    }
    function parseMulDiv() {
        var left = parseUnary();
        while (peek().value === '*' || peek().value === '/' || peek().value === '%') {
            var op = consume().value;
            var right = parseUnary();
            left = { type: 'binary', op: op, left: left, right: right, line: _curLine };
        }
        return left;
    }
    function parseUnary() {
        if (peek().value === '+' || peek().value === '-' || peek().value === '!' || peek().value === '~') {
            var op = consume().value;
            return { type: 'unary', op: op, arg: parseUnary() };
        }
        if (peek().value === '++') { consume(); var id = expect('identifier').value; return { type: 'unary', op: '++', arg: { type: 'variable', name: id } }; }
        if (peek().value === '--') { consume(); var id2 = expect('identifier').value; return { type: 'unary', op: '--', arg: { type: 'variable', name: id2 } }; }
        if (peek().value === '&') { consume(); var id3 = expect('identifier').value; return { type: 'addrOf', name: id3 }; }
        if (peek().value === '*') { consume(); return { type: 'deref', expr: parseUnary() }; }
        return parsePrimary();
    }

    function parsePrimary() {
        var t = peek();
        if (t.value === 'new') {
            consume();
            var typeName = consume().value;
            var cArgs = [];
            if (peek().value === '(') {
                consume();
                while (peek().value !== ')') { cArgs.push(parseExpression()); if (peek().value === ',') consume(); }
                expect('symbol', ')');
            }
            return { type: 'newExpr', structType: typeName, args: cArgs };
        }
        if (t.type === 'number') { consume(); return { type: 'number', value: t.value, isFloat: t.value.indexOf('.') >= 0 }; }
        if (t.type === 'string') {
            consume();
            var raw = t.value;
            var s = raw.substring(1, raw.length - 1);
            s = s.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\\\\\\\/g, '\\\\').replace(/\\\\\"/g, '\"').replace(/\\'/g, "'");
            return { type: 'string', value: s };
        }
        if (t.value === 'true' || t.value === 'false') { consume(); return { type: 'bool', value: t.value === 'true' }; }
        if (t.type === 'phpVar') {
            consume();
            var name = t.value;
            if (peek().value === '[') { consume(); var index = parseExpression(); expect('symbol', ']'); return { type: 'arrayAccess', name: name, index: index }; }
            return { type: 'variable', name: name };
        }
        if (t.type === 'identifier') {
            consume();
            var name = t.value;
            if (peek().type === 'operator' && peek().value === '::') {
                consume();
                var nsName = name;
                if (peek().type !== 'identifier') throw new ScriptError("命名空间限定符后需要函数名");
                var funcName = consume().value;
                if (peek().value !== '(') throw new ScriptError("命名空间限定符后需要函数调用");
                consume();
                var nsArgs = [];
                while (peek().value !== ')') { nsArgs.push(parseExpression()); if (peek().value === ',') consume(); }
                expect('symbol', ')');
                return { type: 'call', namespace: nsName, name: funcName, args: nsArgs, line: t.line };
            }
            if (peek().value === '(') {
                consume();
                var args = [];
                while (peek().value !== ')') { args.push(parseExpression()); if (peek().value === ',') consume(); }
                expect('symbol', ')');
                return { type: 'call', name: name, args: args, line: t.line };
            }
            if (peek().value === '[') {
                consume();
                var index = parseExpression();
                expect('symbol', ']');
                if (peek().value === '[') {
                    consume();
                    var index2 = parseExpression();
                    expect('symbol', ']');
                    return { type: 'arrayAccess', name: name, index: index, index2: index2 };
                }
                return { type: 'arrayAccess', name: name, index: index };
            }
            if (peek().value === '.') {
                consume();
                var member = expect('identifier').value;
                if (peek().value === '(') {
                    consume();
                    var mArgs = [];
                    while (peek().value !== ')') { mArgs.push(parseExpression()); if (peek().value === ',') consume(); }
                    expect('symbol', ')');
                    return { type: 'methodCall', obj: name, method: member, args: mArgs };
                }
                return { type: 'memberAccess', obj: name, member: member };
            }
            if (peek().value === '->') {
                consume();
                var arrowMember = expect('identifier').value;
                if (peek().value === '(') {
                    consume();
                    var aArgs = [];
                    while (peek().value !== ')') { aArgs.push(parseExpression()); if (peek().value === ',') consume(); }
                    expect('symbol', ')');
                    return { type: 'arrowCall', ptr: name, method: arrowMember, args: aArgs };
                }
                return { type: 'arrowAccess', ptr: name, member: arrowMember };
            }
            if (peek().value === '++') { consume(); return { type: 'postInc', name: name }; }
            if (peek().value === '--') { consume(); return { type: 'postDec', name: name }; }
            return { type: 'variable', name: name };
        }
        if (t.value === '(') {
            consume();
            var expr = parseExpression();
            expect('symbol', ')');
            if (peek().value === '.') {
                consume();
                var dotMember = expect('identifier').value;
                if (peek().value === '(') {
                    consume(); var dArgs = [];
                    while (peek().value !== ')') { dArgs.push(parseExpression()); if (peek().value === ',') consume(); }
                    expect('symbol', ')');
                    return { type: 'methodCall', obj: null, method: dotMember, args: dArgs, base: expr };
                }
                return { type: 'memberAccess', obj: null, member: dotMember, base: expr };
            }
            if (peek().value === '->') {
                consume();
                var arrMember = expect('identifier').value;
                if (peek().value === '(') {
                    consume(); var aArgs2 = [];
                    while (peek().value !== ')') { aArgs2.push(parseExpression()); if (peek().value === ',') consume(); }
                    expect('symbol', ')');
                    return { type: 'arrowCall', ptr: null, method: arrMember, args: aArgs2, base: expr };
                }
                return { type: 'arrowAccess2', base: expr, member: arrMember };
            }
            return expr;
        }
        throw new ScriptError('第' + (t.line || '?') + '行: 意外的 token: ' + t.value);
    }

    // === 顶层 ===
    var namespaces = { 'qlgstd': { functions: {} } };
    if (extraAsts) {
        for (var ea_lib in extraAsts) {
            var ea_sub = extraAsts[ea_lib];
            if (ea_sub && ea_sub.namespaces) {
                for (var ea_nsk in ea_sub.namespaces) {
                    if (!namespaces[ea_nsk]) namespaces[ea_nsk] = { functions: {} };
                    for (var ea_fnk in ea_sub.namespaces[ea_nsk].functions) {
                        namespaces[ea_nsk].functions[ea_fnk] = ea_sub.namespaces[ea_nsk].functions[ea_fnk];
                    }
                }
            }
        }
    }
    var currentNs = 'qlgstd';
    var globalStmts = [];
    while (peek().type !== 'eof') {
        if (peek().type === 'include') {
            var incTok = consume();
            var incMatch = incTok.value.match(/^#include\s*<([^>]+)>/);
            if (incMatch) {
                var libName = incMatch[1];
                // 搜索路径：工作目录/library/ 或 工作目录/
                var searchPaths = [
                    path.join(_currentWorkingDir, 'library', libName + '.qlg'),
                    path.join(_currentWorkingDir, libName + '.qlg')
                ];
                var libCode = '';
                var found = false;
                for (var sp of searchPaths) {
                    if (fs.existsSync(sp)) {
                        try {
                            libCode = fs.readFileSync(sp, 'utf8');
                            found = true;
                            break;
                        } catch (e) {
                            // 尝试下一个路径
                        }
                    }
                }
                if (!found) {
                    throw new ScriptError("[库: " + libName + ".qlg] 文件不存在");
                }
                libCode = libCode.replace(/^#defNS\s+\w+;?\s*$/gm, '').replace(/^using\s+namespace\s+\w+;?\s*$/gm, '').trim();
                if (!libCode) throw new ScriptError("[库: " + libName + ".qlg] 内容为空");
                var subAst = parse(libCode);
                for (var fk in subAst.namespaces) {
                    if (!namespaces[fk]) namespaces[fk] = { functions: {} };
                    for (var fnk in subAst.namespaces[fk].functions) {
                        namespaces[fk].functions[fnk] = subAst.namespaces[fk].functions[fnk];
                    }
                }
            }
            continue;
        }
        if (peek().value === 'using' && tokens[pos + 1] && tokens[pos + 1].value === 'namespace') {
            consume(); consume();
            var nsName = expect('identifier').value;
            if (peek().value === ';') consume();
            if (!namespaces[nsName]) namespaces[nsName] = { functions: {} };
            continue;
        }
        if (peek().type === 'symbol' && peek().value === '#' && tokens[pos + 1] && tokens[pos + 1].value === 'defNS') {
            consume(); consume();
            var defNsName = expect('identifier').value;
            if (!namespaces[defNsName]) namespaces[defNsName] = { functions: {} };
            currentNs = defNsName;
            continue;
        }
        if (peek().type === 'define') { var _defTok = consume(); typeAliases[_defTok.name] = _defTok.value; continue; }
        if (peek().type === 'gc') { var _gcTok2 = consume(); ast.globalStmts.push({ type: 'gc', varName: _gcTok2.varName }); continue; }
        if (peek().value === 'typedef') { consume(); var _s2 = consume().value; var _d2 = expect('identifier').value; expect('symbol', ';'); typeAliases[_d2] = _s2; continue; }
        var typeKw = { 'int': true, 'float': true, 'double': true, 'char': true, 'string': true, 'bool': true, 'void': true, 'stack': true, 'queue': true, 'vector': true, 'pair': true, 'priority_queue': true, 'short': true, 'long': true, 'unsigned': true, 'longlong': true, 'int64': true, 'uint': true, 'int32': true };
        if (typeKw[peek().value]) {
            var typeName = consume().value;
            var funcName = peek();
            if (funcName.type === 'identifier' && tokens[pos + 1] && tokens[pos + 1].value === '(') {
                pos--;
                var func = parseFunction();
                namespaces[currentNs].functions[func.name] = func;
            } else {
                pos--;
                var stmt = parseStatement();
                globalStmts.push(stmt);
            }
        } else if (peek().value === 'struct') {
            var sd = parseStructDef();
            globalStmts.push(sd);
        } else if (peek().value === 'void' && tokens[pos + 1] && tokens[pos + 1].type === 'identifier' && tokens[pos + 2] && tokens[pos + 2].value === '(') {
            globalStmts.push(parseStatement());
        } else {
            consume();
        }
    }
    return { namespaces: namespaces, globalStmts: globalStmts };
}