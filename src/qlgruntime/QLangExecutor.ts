// QLangExecutor — AST 执行器 / 虚拟机
// @ts-nocheck

import { defaultValue, clampValue, isTypeLike } from './QLangTypes';
import { dispatchBuiltin, stringify, isTruthy, ScriptError } from './QLangBuiltins';
import * as Mem from './QLangMemory';

export var QLANG_MAX_STACK_DEPTH = 5000;
export var QLANG_TIMEOUT_MS = 10000;
export var QLANG_TOTAL_TIMEOUT_MS = 10000;
export var QLANG_MAX_ARRAY_SIZE = 5000000;
export var QLANG_MAX_VARS = 500;
export var QLANG_MAX_2D_ARRAY = 1000000;
export var QLANG_MEMORY_SIZE = 268435456;

// 内存系统迁移到 QLangMemory.ts（fatAlloc + 类型编码读写）
export var QLANG_SCOPE_ID = 0;
export var globalEnv = {};

function allocAddr() {
    return Mem.fatAlloc(1) * Mem.SLOT_SIZE;
}

function createScope(parent) {
    return { id: QLANG_SCOPE_ID++, parent: parent, vars: {} };
}

function declareVar(scope, name, value, type, isConst, isRef) {
    if (isRef) {
        scope.vars[name] = { addr: value, type: type, isConst: !!isConst, isRef: true };
        return value;
    }
    // 数组类型：直接存地址值
    if (type && type.indexOf('[]') >= 0) {
        scope.vars[name] = { addr: value, type: type, isConst: !!isConst };
        return value;
    }
    var addr = allocAddr();
    var code = Mem.typeNameToCode(type);
    Mem.writeValue(addr, code, clampValue(value, type));
    scope.vars[name] = { addr: addr, type: type, isConst: !!isConst };
    return addr;
}

function findVar(scope, name) {
    var s = scope;
    while (s) {
        if (s.vars[name] !== undefined) return { info: s.vars[name], scope: s };
        s = s.parent;
    }
    return null;
}

function getVar(scope, name) {
    var found = findVar(scope, name);
    if (!found) throw new ScriptError("未定义: " + name);
    if (found.info.isRef) {
        // 引用：返回地址本身（不是地址处的值）
        return found.info.addr;
    }
    // 数组类型直接返回地址值
    if (found.info.type && found.info.type.indexOf('[]') >= 0) {
        return found.info.addr;
    }
    var code = Mem.typeNameToCode(found.info.type);
    return Mem.readValue(found.info.addr, code);
}

function setVar(scope, name, value) {
    var found = findVar(scope, name);
    if (!found) { declareVar(scope, name, value, "auto", false); return; }
    if (found.info.isConst) throw new ScriptError("不能修改 const: " + name);
    if (found.info.isRef) {
        // 引用：addr 是目标变量的地址，写入该地址
        var _refCode = Mem.typeNameToCode(found.info.type);
        Mem.writeValue(found.info.addr, _refCode, clampValue(value, found.info.type));
        return;
    }
    var code = Mem.typeNameToCode(found.info.type);
    Mem.writeValue(found.info.addr, code, clampValue(value, found.info.type));
}

function addrOf(scope, name) {
    var found = findVar(scope, name);
    if (!found) throw new ScriptError("未定义: " + name);
    return found.info.addr;
}

// handleCall: 处理函数调用（内置 + 自定义）
function handleCall(expr, scope, startTime, depth) {
    var builtinResult = dispatchBuiltin(expr, evalExpr, scope, startTime, depth);
    if (builtinResult !== undefined) return builtinResult;

    // 自定义函数
    if (globalEnv && globalEnv['__ast__']) {
        var ns3 = expr.namespace || (globalEnv['__namespace__'] || 'qlgstd');
        var funcs = globalEnv['__ast__'].namespaces && globalEnv['__ast__'].namespaces[ns3] && globalEnv['__ast__'].namespaces[ns3].functions;
        if (funcs && funcs[expr.name]) {
            var func = funcs[expr.name];
            var funcArgs = [];
            for (var ai = 0; ai < expr.args.length; ai++) {
                // 如果参数是引用，传地址
                if (func.params[ai] && func.params[ai].isRef) {
                    var refName = expr.args[ai].name;
                    var refFound = findVar(scope, refName);
                    if (!refFound) throw new ScriptError("引用参数 " + refName + " 未定义");
                    funcArgs.push(refFound.info.addr);
                } else {
                    funcArgs.push(evalExpr(expr.args[ai], scope, startTime, depth));
                }
            }
            return callFunction(func, funcArgs, scope, globalEnv['__outputs__'], startTime, depth + 1);
        }
    }
    throw new ScriptError((expr.line ? '第' + expr.line + '行: ' : '') + "未定义函数: " + expr.name);
}

// handleNewExpr
function handleNewExpr(expr, scope, startTime, depth) {
    if (!globalEnv || !globalEnv['__structs__'] || !globalEnv['__structs__'][expr.structType]) {
        throw new ScriptError("未定义的结构体: " + expr.structType);
    }
    var structDef = globalEnv['__structs__'][expr.structType];
    var initArgs = [];
    for (var ni = 0; ni < expr.args.length; ni++) {
        initArgs.push(evalExpr(expr.args[ni], scope, startTime, depth));
    }
    // 结构体字段在二进制表中：分配连续槽位，每个字段占一个槽
    var baseSlot = Mem.fatAlloc(structDef.fields.length);
    var baseAddr = baseSlot * Mem.SLOT_SIZE;
    for (var fi = 0; fi < structDef.fields.length; fi++) {
        var f = structDef.fields[fi];
        var fv = fi < initArgs.length ? initArgs[fi] : defaultValue(f.type);
        var fcode = Mem.typeNameToCode(f.type);
        var faddr = baseAddr + fi * Mem.SLOT_SIZE;
        Mem.writeValue(faddr, fcode, fv);
    }
    return baseAddr;
}

// callFunction
function callFunction(func, args, callScope, outputs, startTime, depth) {
    if (depth === undefined) depth = 0;
    if (depth > QLANG_MAX_STACK_DEPTH) throw new ScriptError("栈溢出");
    var funcScope = createScope(callScope);
    for (var pi = 0; pi < func.params.length; pi++) {
        var param = func.params[pi];
        if (param.isRef) {
            // 引用参数：args[pi] 已经是地址，声明为引用变量
            declareVar(funcScope, param.name, pi < args.length ? args[pi] : 0, 'int', false, true);
        } else {
            var pv = pi < args.length ? args[pi] : 0;
            declareVar(funcScope, param.name, pv, param.type, false);
        }
    }
    for (var si = 0; si < func.body.length; si++) {
        var r = execStmt(func.body[si], funcScope, outputs, startTime, depth, null);
        if (r && r.type === 'return') return r.value;
        if (r && r.type === 'goto') {
            var _targetLabel = r.label;
            var _found = -1;
            for (var _gi = 0; _gi < func.body.length; _gi++) {
                if (func.body[_gi].type === 'setap' && func.body[_gi].label === _targetLabel) {
                    _found = _gi;
                    break;
                }
            }
            if (_found === -1) throw new ScriptError("锚点 " + _targetLabel + " 未定义");
            si = _found;
            continue;
        }
    }
    return 0;
}

export function execStmt(stmt, scope, outputs, startTime, depth, loopEnv) {
    if (Date.now() - startTime > QLANG_TOTAL_TIMEOUT_MS) throw new ScriptError("执行超时");
    if (!stmt) return;

    switch (stmt.type) {
        case 'empty': return;
        case 'gc': {
            // #gc var 从作用域删除变量
            if (stmt.varName) {
                var _s = scope;
                while (_s) {
                    if (_s.vars && _s.vars[stmt.varName] !== undefined) {
                        delete _s.vars[stmt.varName];
                        return;
                    }
                    _s = _s.parent;
                }
            }
            return;
        }
        case 'block': {
            var blockScope = createScope(scope);
            for (var bi = 0; bi < stmt.body.length; bi++) {
                var rb = execStmt(stmt.body[bi], blockScope, outputs, startTime, depth, loopEnv);
                if (rb && (rb.type === 'return' || rb.type === 'break' || rb.type === 'continue' || rb.type === 'goto')) return rb;
            }
            return;
        }
        case 'varDecl': {
            var val = stmt.init !== null ? evalExpr(stmt.init, scope, startTime, depth) : defaultValue(stmt.varType);
            declareVar(scope, stmt.name, val, stmt.varType, stmt.isConst);
            return;
        }
        case 'arrayDecl': {
            var size = stmt.size ? evalExpr(stmt.size, scope, startTime, depth) : (stmt.init ? stmt.init.length : 1);
            if (typeof size !== 'number' || size <= 0 || size > QLANG_MAX_ARRAY_SIZE) throw new ScriptError("数组大小无效");
            var dv = defaultValue(stmt.varType);
            var dcode = Mem.typeNameToCode(stmt.varType);
            // 分配数组头部 + 元素槽位
            var totalSlots = 1 + size; // [header] [elem0] [elem1] ...
            var arrBaseSlot = Mem.fatAlloc(totalSlots);
            var arrAddr = arrBaseSlot * Mem.SLOT_SIZE;
            Mem.writeInt32(arrAddr, size); // 数组头：存大小
            for (var ai = 0; ai < size; ai++) {
                var aval = (stmt.init && ai < stmt.init.length) ? evalExpr(stmt.init[ai], scope, startTime, depth) : dv;
                var eAddr = arrAddr + (ai + 1) * Mem.SLOT_SIZE;
                Mem.writeValue(eAddr, dcode, aval);
            }
            scope.vars[stmt.name] = { addr: arrAddr, type: stmt.varType + '[]', isConst: !!stmt.isConst };
            return;
        }
        case 'assign': { setVar(scope, stmt.name, evalExpr(stmt.value, scope, startTime, depth)); return; }
        case 'compAssign': {
            var old = getVar(scope, stmt.name);
            var dv2 = evalExpr(stmt.value, scope, startTime, depth);
            if (stmt.op === '+=') setVar(scope, stmt.name, old + dv2);
            else if (stmt.op === '-=') setVar(scope, stmt.name, old - dv2);
            return;
        }
        case 'arrAssign': {
            var arrInfo = findVar(scope, stmt.name);
            if (!arrInfo) throw new ScriptError("数组 " + stmt.name + " 未定义");
            var arrBase = arrInfo.info.addr;
            var arrSize = Mem.readInt32(arrBase);
            var idx = evalExpr(stmt.index, scope, startTime, depth);
            if (idx < 0 || idx >= arrSize) throw new ScriptError("数组索引越界", stmt.line);
            var eAddr = arrBase + (idx + 1) * Mem.SLOT_SIZE;
            var arrType = arrInfo.info.type.replace('[]', '');
            var arrCode = Mem.typeNameToCode(arrType);
            var oldVal = Mem.readValue(eAddr, arrCode);
            var val = evalExpr(stmt.value, scope, startTime, depth);
            var newVal;
            if (stmt.op === '=') newVal = val;
            else if (stmt.op === '+=') newVal = (oldVal||0) + val;
            else if (stmt.op === '-=') newVal = (oldVal||0) - val;
            else newVal = val;
            Mem.writeValue(eAddr, arrCode, clampValue(newVal, arrType));
            return;
        }
        case 'memberAssign': {
            var obj = getVar(scope, stmt.obj);
            if (typeof obj === 'number' && globalEnv && globalEnv['__structs__']) {
                for (var _stn2 in globalEnv['__structs__']) {
                    var _stdef2 = globalEnv['__structs__'][_stn2];
                    for (var _sfi2 = 0; _sfi2 < _stdef2.fields.length; _sfi2++) {
                        if (_stdef2.fields[_sfi2].name === stmt.member) {
                            var _code2 = Mem.typeNameToCode(_stdef2.fields[_sfi2].type);
                            var _val2 = evalExpr(stmt.value, scope, startTime, depth);
                            Mem.writeValue(obj + _sfi2 * Mem.SLOT_SIZE, _code2, _val2);
                            return;
                        }
                    }
                }
            }
            obj[stmt.member] = evalExpr(stmt.value, scope, startTime, depth);
            return;
        }
        case 'derefAssign': {
            var derefAddr = getVar(scope, stmt.ptrName);
            if (typeof derefAddr !== 'number') throw new ScriptError("解引用赋值需要指针");
            if (derefAddr === 0) throw new ScriptError("访问违例");
            Mem.writeInt32(derefAddr, evalExpr(stmt.value, scope, startTime, depth));
            return;
        }
        case 'arrowAssign': {
            var aPtr = getVar(scope, stmt.ptr);
            if (aPtr === 0) throw new ScriptError("访问违例");
if (typeof aPtr !== 'number') throw new ScriptError("箭头赋值需要指针");
            var _member = stmt.member;
            var _setVal = evalExpr(stmt.value, scope, startTime, depth);
            var _qidMatch2 = _member.match(/^(\d+)_(num|text)$/) || _member.match(/^q(\d+)_(num|text)$/);
            if (_qidMatch2) {
                var _qIdx2 = parseInt(_qidMatch2[1]) - 1;
                if (_qidMatch2[2] === 'text') { Mem.writeString(aPtr + (_qIdx2 * 2 + 1) * Mem.SLOT_SIZE, _setVal); return; }
                Mem.writeInt32(aPtr + _qIdx2 * 2 * Mem.SLOT_SIZE, _setVal); return;
            }
            if (_member === '_num') { Mem.writeInt32(aPtr, _setVal); return; }
            if (_member === '_text') { Mem.writeString(aPtr + Mem.SLOT_SIZE, _setVal); return; }
            // 通用结构体：查字段偏移
            if (globalEnv && globalEnv['__structs__']) {
                for (var _snC in globalEnv['__structs__']) {
                    var _sdC = globalEnv['__structs__'][_snC];
                    for (var _sfiC = 0; _sfiC < _sdC.fields.length; _sfiC++) {
                        if (_sdC.fields[_sfiC].name === _member) {
                            var _codeC = Mem.typeNameToCode(_sdC.fields[_sfiC].type);
                            Mem.writeValue(aPtr + _sfiC * Mem.SLOT_SIZE, _codeC, _setVal);
                            return;
                        }
                    }
                }
            }
            Mem.writeInt32(aPtr, _setVal);
            return;
        }
        case 'if': {
            var condVal = evalExpr(stmt.cond, scope, startTime, depth);
            if (isTruthy(condVal)) return execStmt(stmt.then, scope, outputs, startTime, depth, loopEnv);
            else if (stmt.else) return execStmt(stmt.else, scope, outputs, startTime, depth, loopEnv);
            return;
        }
        case 'while': {
            var maxIter = 100000, iter = 0, wStart = Date.now();
            while (isTruthy(evalExpr(stmt.cond, scope, startTime, depth))) {
                if (Date.now() - wStart > 10000) throw new ScriptError("while 超时");
                if (++iter > maxIter) throw new ScriptError("循环超限");
                var rw = execStmt(stmt.body, scope, outputs, startTime, depth, loopEnv);
                if (rw && rw.type === 'return') return rw;
                if (rw && rw.type === 'break') break;
            }
            return;
        }
        case 'for': {
            var forScope = createScope(scope);
            if (stmt.init) execStmt(stmt.init, forScope, outputs, startTime, depth, null);
            var maxIterF = 100000, iterF = 0, fStart = Date.now();
            while (!stmt.cond || isTruthy(evalExpr(stmt.cond, forScope, startTime, depth))) {
                if (Date.now() - fStart > 10000) throw new ScriptError("for 超时");
                if (++iterF > maxIterF) throw new ScriptError("循环超限");
                var rf = execStmt(stmt.body, forScope, outputs, startTime, depth, null);
                if (rf && rf.type === 'return') return rf;
                if (rf && rf.type === 'break') break;
                if (stmt.inc) {
                    if (stmt.inc.type === 'forInc') {
                        var oldF = getVar(forScope, stmt.inc.name);
                        var d = evalExpr(stmt.inc.value, forScope, startTime, depth);
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
                var ns4 = globalEnv['__namespace__'] || 'qlgstd';
                if (!globalEnv['__ast__'].namespaces) globalEnv['__ast__'].namespaces = {};
                if (!globalEnv['__ast__'].namespaces[ns4]) globalEnv['__ast__'].namespaces[ns4] = { functions: {} };
                globalEnv['__ast__'].namespaces[ns4].functions[stmt.name] = stmt;
            }
            return;
        }
        case 'return': {
            var retVal = stmt.value !== null ? evalExpr(stmt.value, scope, startTime, depth) : 0;
            return { type: 'return', value: retVal };
        }
        case 'break': return { type: 'break' };
        case 'continue': return { type: 'continue' };
        case 'print': {
            var parts = [];
            for (var pri = 0; pri < stmt.args.length; pri++) parts.push(stringify(evalExpr(stmt.args[pri], scope, startTime, depth)));
            outputs.push(parts.join(''));
            return;
        }
        case 'cout': {
            var result = '';
            for (var ci = 0; ci < stmt.parts.length; ci++) {
                var part = stmt.parts[ci];
                if (part.type === 'endl') { result += '\n'; continue; }
                result += stringify(evalExpr(part, scope, startTime, depth));
            }
            outputs.push(result);
            return;
        }
        case 'expr': { evalExpr(stmt.expr, scope, startTime, depth); return; }
        case 'phpVarDecl': { setVar(scope, stmt.name, evalExpr(stmt.init, scope, startTime, depth)); return; }
        case 'structDef': {
            if (!globalEnv['__structs__']) globalEnv['__structs__'] = {};
            globalEnv['__structs__'][stmt.structName] = stmt;
            return;
        }
        case 'tryCatch': {
            try {
                for (var tsi = 0; tsi < stmt.tryBody.length; tsi++) {
                    var tr = execStmt(stmt.tryBody[tsi], scope, outputs, startTime, depth, null);
                    if (tr && (tr.type === 'return' || tr.type === 'break' || tr.type === 'continue')) return tr;
                }
            } catch (e) {
                var errMsg = e instanceof ScriptError ? e.message : String(e.message || e);
                var catchScope = createScope(scope);
                declareVar(catchScope, stmt.catchVar, errMsg, 'string', false);
                for (var csi = 0; csi < stmt.catchBody.length; csi++) {
                    var cr = execStmt(stmt.catchBody[csi], catchScope, outputs, startTime, depth, null);
                    if (cr && (cr.type === 'return' || cr.type === 'break' || cr.type === 'continue')) return cr;
                }
            }
            return;
        }
        case 'setap': return;
        case 'gotoap': return { type: 'goto', label: stmt.label };
        case 'throw': {
            var throwVal = evalExpr(stmt.value, scope, startTime, depth);
            throw new ScriptError(String(throwVal));
        }
        default: throw new ScriptError("不支持的语句: " + stmt.type);
    }
}

export function evalExpr(expr, scope, startTime, depth) {
    if (!expr || typeof expr !== 'object') return expr;
    switch (expr.type) {
        case 'literal': return expr.value;
        case 'number': return expr.isFloat ? parseFloat(expr.value) : parseInt(expr.value);
        case 'string': return expr.value;
        case 'variable': return getVar(scope, expr.name);
        case 'phpVar': return getVar(scope, expr.value);
        case 'ternary': {
            var condVal = evalExpr(expr.cond, scope, startTime, depth);
            return isTruthy(condVal) ? evalExpr(expr.trueExpr, scope, startTime, depth) : evalExpr(expr.falseExpr, scope, startTime, depth);
        }
        case 'unary': {
            var v = evalExpr(expr.arg || expr.expr, scope, startTime, depth);
            if (expr.op === '-') return (typeof v === 'number' && Number.isInteger(v)) ? Mem.twosComplement(-v, 32) : -v;
            if (expr.op === '!') return !isTruthy(v);
            if (expr.op === '~') return ~(v|0);
            if (expr.op === '++') { var nv = (typeof v === 'number' && Number.isInteger(v)) ? Mem.twosAdd(v|0, 1, Mem.TYPE_INT32) : v + 1; setVar(scope, expr.arg.name, nv); return nv; }
if (expr.op === '--') { var nv2 = (typeof v === 'number' && Number.isInteger(v)) ? Mem.twosSub(v|0, 1, Mem.TYPE_INT32) : v - 1; setVar(scope, expr.arg.name, nv2); return nv2; }
            return v;
        }
        case 'postInc':
        case 'postInc': { var ov = getVar(scope, expr.name); setVar(scope, expr.name, (typeof ov === 'number' && Number.isInteger(ov)) ? Mem.twosAdd(ov|0, 1, Mem.TYPE_INT32) : ov + 1); return ov; }
        case 'postDec': { var ov2 = getVar(scope, expr.name); setVar(scope, expr.name, (typeof ov2 === 'number' && Number.isInteger(ov2)) ? Mem.twosSub(ov2|0, 1, Mem.TYPE_INT32) : ov2 - 1); return ov2; }
        case 'binary': {
            var l = evalExpr(expr.left, scope, startTime, depth);
            var r = evalExpr(expr.right, scope, startTime, depth);
            // 判定是否为整型运算（两边都是整数，且都不是浮点数面量）
            var _isFloatExpr = function(ex) { return ex && ex.type === 'number' && ex.isFloat; };
            var isIntOp = typeof l === 'number' && typeof r === 'number' && Number.isInteger(l) && Number.isInteger(r) && !_isFloatExpr(expr.left) && !_isFloatExpr(expr.right);
            switch (expr.op) {
                case '+': 
                    if (typeof l === 'string' || typeof r === 'string') return String(l) + String(r);
                    if (isIntOp) return Mem.twosAdd(l|0, r|0, Mem.TYPE_INT32);
                    return (l||0) + (r||0);
                case '-': 
                    if (isIntOp) return Mem.twosSub(l|0, r|0, Mem.TYPE_INT32);
                    return (l||0) - (r||0);
                case '*': 
                    if (isIntOp) return Mem.twosMul(l|0, r|0, Mem.TYPE_INT32);
                    return (l||0) * (r||0);
                case '/': 
                    if (r === 0) throw new ScriptError("除零", expr.line);
                    if (isIntOp) return Mem.twosDiv(l|0, r|0, Mem.TYPE_INT32);
                    return l / r;
                case '%': return isIntOp ? Mem.twosComplement((l|0) % (r|0), 32) : l % r;
                case '==': return l == r;
                case '!=': return l != r;
                case '<': return l < r;
                case '>': return l > r;
                case '<=': return l <= r;
                case '>=': return l >= r;
                case '&&': case 'and': return isTruthy(l) && isTruthy(r);
                case '||': case 'or': return isTruthy(l) || isTruthy(r);
                case '|': return Mem.twosComplement((l|0) | (r|0), 32);
                case '^': return Mem.twosComplement((l|0) ^ (r|0), 32);
                case '&': return (l|0) & (r|0);
                case '<<': return Mem.twosComplement((l|0) << (r|0), 32);
                case '>>': return (l|0) >> (r|0);
                default: return 0;
            }
        }
        case 'call': return handleCall(expr, scope, startTime, depth);
        case 'methodCall': {
            var objV = getVar(scope, expr.obj);
            var mArgs = [];
            for (var mi = 0; mi < expr.args.length; mi++) mArgs.push(evalExpr(expr.args[mi], scope, startTime, depth));
            // STL 二进制方法映射
            if (typeof objV === 'number') {
                var _stlMethodMap2 = {
                    'push': 'stlPush', 'pop': 'stlPop', 'top': 'stlTop',
                    'push_back': 'stlPush', 'pop_back': 'stlPop',
                    'get': 'stlRead', 'set': 'stlWrite',
                    'front': 'stlFront', 'back': 'stlBack',
                    'size': 'stlSize', 'empty': 'stlEmpty',
                    'first': 'stlFirst', 'second': 'stlSecond'
                };
                var _stlFn = _stlMethodMap2[expr.method];
                if (_stlFn && Mem[_stlFn]) {
                    return Mem[_stlFn].apply(null, [objV].concat(mArgs));
                }
            }
            var method = objV[expr.method];
            if (typeof method !== 'function') throw new ScriptError("方法 " + expr.method + " 不存在");
            return method.apply(objV, mArgs);
        }
        case 'memberAccess': {
            var o = expr.base ? evalExpr(expr.base, scope, startTime, depth) : getVar(scope, expr.obj);
            if (o === null || o === undefined) throw new ScriptError("对象 " + (expr.obj || 'expr') + " 未定义");
            // 如果 o 是数字（地址），通过结构体定义查字段偏移
            if (typeof o === 'number' && globalEnv && globalEnv['__structs__']) {
                for (var _stn in globalEnv['__structs__']) {
                    var _stdef = globalEnv['__structs__'][_stn];
                    for (var _sfi = 0; _sfi < _stdef.fields.length; _sfi++) {
                        if (_stdef.fields[_sfi].name === expr.member) {
                            var _code = Mem.typeNameToCode(_stdef.fields[_sfi].type);
                            return Mem.readValue(o + _sfi * Mem.SLOT_SIZE, _code);
                        }
                    }
                }
            }
            return o[expr.member];
        }
        case 'arrayAccess': {
            var arrAddr = getVar(scope, expr.name);
            var idx = evalExpr(expr.index, scope, startTime, depth);
            if (typeof arrAddr !== 'number') throw new ScriptError("数组访问需要数字地址");
            // 数组首地址 + (index + 1) * SLOT_SIZE（第0个元素在偏移1个槽位）
            var elemAddr = arrAddr + (idx + 1) * Mem.SLOT_SIZE;
            return Mem.readInt32(elemAddr);
        }
        case 'newExpr': return handleNewExpr(expr, scope, startTime, depth);
        case 'arrowAccess2': {
            var baseVal = evalExpr(expr.base, scope, startTime, depth);
            if (baseVal === 0) throw new ScriptError("访问违例");
            if (typeof baseVal !== 'number') throw new ScriptError("箭头访问需要指针");
            if (expr.member && typeof expr.member === 'string') {
                    var _qidMatch3 = expr.member.match(/^(\d+)_(num|text)$/) || expr.member.match(/^q(\d+)_(num|text)$/);
                if (_qidMatch3) {
                    var _qIdx3 = parseInt(_qidMatch3[1]) - 1;
                    if (_qidMatch3[2] === 'text') return Mem.readString(baseVal + (_qIdx3 * 2 + 1) * Mem.SLOT_SIZE);
                    return Mem.readInt32(baseVal + _qIdx3 * 2 * Mem.SLOT_SIZE);
                }
                if (expr.member.endsWith('_num')) return Mem.readInt32(baseVal);
                if (expr.member.endsWith('_text')) return Mem.readString(baseVal + Mem.SLOT_SIZE);
                if (globalEnv && globalEnv['__structs__']) {
                    for (var _snB in globalEnv['__structs__']) {
                        var _sdB = globalEnv['__structs__'][_snB];
                        for (var _sfiB = 0; _sfiB < _sdB.fields.length; _sfiB++) {
                            if (_sdB.fields[_sfiB].name === expr.member) {
                                var _codeB = Mem.typeNameToCode(_sdB.fields[_sfiB].type);
                                return Mem.readValue(baseVal + _sfiB * Mem.SLOT_SIZE, _codeB);
                            }
                        }
                    }
                }
            }
            return Mem.readInt32(baseVal);
        }
        case 'addrOf': return addrOf(scope, expr.name);
        case 'deref': {
            var ptrAddr = evalExpr(expr.expr, scope, startTime, depth);
            if (ptrAddr === 0 || ptrAddr === null || ptrAddr === undefined) throw new ScriptError("访问违例");
            if (typeof ptrAddr !== 'number') throw new ScriptError("无效的指针地址");
            return Mem.readInt32(ptrAddr);
        }
        case 'arrowAccess': {
            var ptrAddr = getVar(scope, expr.ptr);
            if (ptrAddr === 0) throw new ScriptError("访问违例");
            if (typeof ptrAddr !== 'number') throw new ScriptError("箭头访问需要指针");
            // QID 兼容：支持 q1_num / q1_text / q2_num 等，每道题占 2 个槽位
            if (expr.member && typeof expr.member === 'string') {
                var _qidMatch = expr.member.match(/^(\d+)_(num|text)$/) || expr.member.match(/^q(\d+)_(num|text)$/);
                if (_qidMatch) {
                    var _qIdx = parseInt(_qidMatch[1]) - 1;
                    if (_qidMatch[2] === 'text') {
                        return Mem.readString(ptrAddr + (_qIdx * 2 + 1) * Mem.SLOT_SIZE);
                    }
                    return Mem.readInt32(ptrAddr + _qIdx * 2 * Mem.SLOT_SIZE);
                }
                if (expr.member.endsWith('_num')) return Mem.readInt32(ptrAddr);
                if (expr.member.endsWith('_text')) return Mem.readString(ptrAddr + Mem.SLOT_SIZE);
                // 通用结构体：查结构体定义找字段偏移
                if (globalEnv && globalEnv['__structs__']) {
                    for (var _snA in globalEnv['__structs__']) {
                        var _sdA = globalEnv['__structs__'][_snA];
                        for (var _sfiA = 0; _sfiA < _sdA.fields.length; _sfiA++) {
                            if (_sdA.fields[_sfiA].name === expr.member) {
                                var _codeA = Mem.typeNameToCode(_sdA.fields[_sfiA].type);
                                return Mem.readValue(ptrAddr + _sfiA * Mem.SLOT_SIZE, _codeA);
                            }
                        }
                    }
                }
            }
            return Mem.readInt32(ptrAddr);
        }
        case 'arrowCall': {
            var ptrAddr2 = getVar(scope, expr.ptr);
            if (typeof ptrAddr2 !== 'number') throw new ScriptError("箭头方法调用需要指针");
            // 简化：箭头方法调用暂不支持（二进制表重构后需要重新实现）
            throw new ScriptError("不支持的方法: " + expr.method);
        }
        case 'bool': return expr.value;
        default: throw new ScriptError("不支持的表达式: " + expr.type);
    }
}