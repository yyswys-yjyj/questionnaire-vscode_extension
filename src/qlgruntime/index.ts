// QLangInterpreter — 入口 + 顶层调度
// VSCode 插件适配版
// @ts-nocheck

import * as fs from 'fs';
import * as path from 'path';

import { parse, ScriptError as ParserScriptError } from './QLangParser';
import { QLANG_SCOPE_ID, execStmt, evalExpr, globalEnv as _execGlobalEnv } from './QLangExecutor';
import { globalEnv as _builtinsGlobalEnv } from './QLangBuiltins';
import * as Mem from './QLangMemory';
import { QLANG_STDLIB } from './QLangStdlib';
import { QLANG_STL_HEADER } from './QLangStdStl';
import { setParserWorkingDir } from './QLangParser';

// Re-export for backward compatibility

export { ScriptError } from './QLangBuiltins';
export { parse } from './QLangParser';

// ============ 工作目录（用于解析库文件路径）============
let _currentWorkingDir: string = process.cwd();

/**
 * 设置当前工作目录（用于解析 #include 路径）
 * 在 VSCode 插件中调用，传入主文件所在目录
 */
export function setQLangWorkingDir(dir: string): void {
    _currentWorkingDir = dir;
}

// ============ 清理行号 ============
function stripLineNumbers(s: string): string {
    if (typeof s !== "string") return "";
    return s.replace(/^\s*(?:\d+\|\s*)+/gm, "");
}

// ============ 同步读取库文件（VSCode 适配）============
function readLibraryFileSync(libName: string): string {
    // 搜索路径：工作目录/library/ 或 工作目录/
    const searchPaths = [
        path.join(_currentWorkingDir, 'library', libName + '.qlg'),
        path.join(_currentWorkingDir, libName + '.qlg')
    ];

    let raw: string | null = null;
    let foundPath: string | null = null;

    for (const p of searchPaths) {
        if (fs.existsSync(p)) {
            foundPath = p;
            break;
        }
    }

    if (!foundPath) {
        throw new Error('[库: ' + libName + '.qlg] 文件不存在 (搜索路径: ' + searchPaths.join(', ') + ')');
    }

    try {
        raw = fs.readFileSync(foundPath, 'utf8');
    } catch (e: any) {
        throw new Error('[库: ' + libName + '.qlg] 读取失败: ' + (e.message || String(e)));
    }

    if (!raw || raw.trim() === '') {
        throw new Error('[库: ' + libName + '.qlg] 文件为空');
    }

    return stripLineNumbers(raw);
}

// ============ 执行 AST ============
function executeAst(ast, answers, otherInputs, qs) {
    if (!ast || !ast.namespaces) {
        throw new ParserScriptError("AST 无效");
    }
    Mem.fatInit();
    QLANG_SCOPE_ID = 0;
    var outputs = [];
    var startTime = Date.now();
    var rootScope = { id: QLANG_SCOPE_ID++, parent: null, vars: {} };
    // 创建 QID 结构体内存：每道题 2 个槽位（num + text），连续分配
    var _qidAddr = 0;
    var _qidKeys = [];
    if (qs && Array.isArray(qs)) {
        for (var _qki = 0; _qki < qs.length; _qki++) {
            if (qs[_qki] && qs[_qki].id) _qidKeys.push(qs[_qki].id);
        }
    }
    if (_qidKeys.length > 0) {
        var _qdSlots = _qidKeys.length * 2; // 每道题：_num + _text
        var _qdBaseSlot = Mem.fatAlloc(_qdSlots);
        _qidAddr = _qdBaseSlot * Mem.SLOT_SIZE;
        var _qdi = 0;
        for (var _qk = 0; _qk < _qidKeys.length; _qk++) {
            var _qid = _qidKeys[_qk];
            var _qidVal = (answers && typeof answers === 'object') ? answers[_qid] : undefined;
            var _qidQType = '';
            if (qs) for (var _qi = 0; _qi < qs.length; _qi++) {
                if (qs[_qi].id === _qid) { _qidQType = qs[_qi].type || ''; break; }
            }
            var _numVal = -1;
            var _textVal = '';
            if (_qidQType === 'text' || _qidQType === 'textarea') {
                _textVal = String(_qidVal || '');
                if (_qidQType === 'textarea') _textVal = _textVal.replace(/\n/g, '\\n');
            } else if (_qidQType === 'single') {
                _textVal = String(_qidVal || '');
                _numVal = _textVal ? 1 : 0;
            } else if (_qidQType === 'multiple') {
                _textVal = Array.isArray(_qidVal) ? _qidVal.join(' ') : String(_qidVal || '');
                _numVal = Array.isArray(_qidVal) ? _qidVal.length : (_qidVal ? 1 : 0);
            } else if (_qidQType === 'rating' || _qidQType === 'likert' || _qidQType === 'nps') {
                _numVal = parseInt(_qidVal) || 0;
                _textVal = String(_numVal);
            } else if (_qidQType === 'time') {
                _textVal = String(_qidVal || '');
                var _parts = _textVal.split(':');
                _numVal = (_parts[0] ? parseInt(_parts[0]) * 3600 : 0) + (_parts[1] ? parseInt(_parts[1]) * 60 : 0) + (_parts[2] ? parseInt(_parts[2]) : 0);
            } else {
                _textVal = String(_qidVal || '');
            }
            Mem.writeInt32(_qidAddr + _qdi * Mem.SLOT_SIZE, _numVal);       // _num
            Mem.writeString(_qidAddr + (_qdi + 1) * Mem.SLOT_SIZE, _textVal); // _text
            _qdi += 2;
        }
    }
    // 注册 QID 结构体定义（支持 qid.q1_text / qid.q1_num 等 . 访问）
    if (_qidAddr !== 0) {
        rootScope.vars['qid'] = { addr: _qidAddr, type: 'int', isConst: false };
    }

    var globalEnv = {
        __outputs__: outputs,
        __startTime__: startTime,
        __ast__: ast,
        __structs__: {},
        __namespace__: 'qlgstd',
    };
    if (_execGlobalEnv.__structs__ && _execGlobalEnv.__structs__['__qid__']) {
        globalEnv.__structs__['__qid__'] = _execGlobalEnv.__structs__['__qid__'];
    }
    _execGlobalEnv.__outputs__ = outputs;
    _execGlobalEnv.__startTime__ = startTime;
    _execGlobalEnv.__ast__ = ast;
    _execGlobalEnv.__structs__ = globalEnv.__structs__;
    _execGlobalEnv.__namespace__ = 'qlgstd';
    _builtinsGlobalEnv.__outputs__ = outputs;
    _builtinsGlobalEnv.__startTime__ = startTime;
    _builtinsGlobalEnv.__ast__ = ast;
    _builtinsGlobalEnv.__structs__ = globalEnv.__structs__;
    _builtinsGlobalEnv.__namespace__ = 'qlgstd';
    if (_qidKeys.length > 0) {
        var _qidFields = [];
        for (var _qfk = 0; _qfk < _qidKeys.length; _qfk++) {
            var _qidKey = _qidKeys[_qfk];
            _qidFields.push({ name: _qidKey + '_num', type: 'int' });
            _qidFields.push({ name: _qidKey + '_text', type: 'string' });
        }
        globalEnv.__structs__['__qid__'] = { structName: '__qid__', fields: _qidFields };
    }
    // 注册内置标准头
    try {
        var _builtinAst = parse(QLANG_STDLIB, {});
        for (var _bfk in _builtinAst.namespaces) {
            if (!ast.namespaces[_bfk]) ast.namespaces[_bfk] = { functions: {} };
            for (var _bfnk in _builtinAst.namespaces[_bfk].functions) {
                ast.namespaces[_bfk].functions[_bfnk] = _builtinAst.namespaces[_bfk].functions[_bfnk];
            }
        }
    } catch (_be) { /* ignore parse errors in stdlib */ }
    // 注册 STL 标准头
    try {
        var _stlAst = parse(QLANG_STL_HEADER, {});
        for (var _sfk in _stlAst.namespaces) {
            if (!ast.namespaces[_sfk]) ast.namespaces[_sfk] = { functions: {} };
            for (var _sfnk in _stlAst.namespaces[_sfk].functions) {
                ast.namespaces[_sfk].functions[_sfnk] = _stlAst.namespaces[_sfk].functions[_sfnk];
            }
        }
    } catch (_se) { /* ignore parse errors in stl */ }

    // 执行全局语句（structDef 等）
    for (var _gsi = 0; _gsi < ast.globalStmts.length; _gsi++) {
        execStmt(ast.globalStmts[_gsi], rootScope, outputs, startTime, 0, null);
    }

    // 查找并调用 main 函数
    if (ast.namespaces['qlgstd'] && ast.namespaces['qlgstd'].functions['main']) {
        var mainFunc = ast.namespaces['qlgstd'].functions['main'];
        var mainArgs = [];
        if (mainFunc.params.length > 0) {
            mainArgs.push(_qidAddr); // qid 的地址
        }
        var _ns = ast.namespaces['qlgstd'];
        if (_ns.functions['main']) {
            var _func = _ns.functions['main'];
            var _args = [];
            var _scope = { id: QLANG_SCOPE_ID++, parent: rootScope, vars: {} };
            for (var _pi = 0; _pi < _func.params.length; _pi++) {
                var _pv = 0;
                if (_func.params[_pi].name === 'qid' && _func.params[_pi].type === 'int') {
                    _pv = _qidAddr;
                }
                var _pSlot = Mem.fatAlloc(1);
                var _pAddr = _pSlot * Mem.SLOT_SIZE;
                Mem.writeInt32(_pAddr, clampValue(_pv, _func.params[_pi].type));
                _scope.vars[_func.params[_pi].name] = { addr: _pAddr, type: _func.params[_pi].type, isConst: false };
            }
            callFunctionInternal(_func, _args, _scope, outputs, startTime, 0, rootScope);
        }
    } else {
        outputs.push("未找到 main 函数");
    }

    return outputs.join('\n');
}

function clampValue(value, type) {
    if (typeof value !== 'number') return value;
    var bounds = { 'short': { min: -32768, max: 32767 }, 'int': { min: -2147483648, max: 2147483647 }, 'int32': { min: -2147483648, max: 2147483647 }, 'long': { min: -2147483648, max: 2147483647 }, 'int64': { min: -9007199254740992, max: 9007199254740992 }, 'longlong': { min: -9007199254740992, max: 9007199254740992 }, 'unsigned': { min: 0, max: 4294967295 }, 'uint': { min: 0, max: 4294967295 } };
    var b = bounds[type];
    if (b) { value = Math.round(value); if (value < b.min) value = b.min; if (value > b.max) value = b.max; }
    return value;
}

function callFunctionInternal(func, args, funcScope, outputs, startTime, depth, rootScope) {
    if (depth === undefined) depth = 0;
    if (depth > 5000) throw new ParserScriptError("栈溢出");
    for (var si = 0; si < func.body.length; si++) {
        var r = execStmt(func.body[si], funcScope, outputs, startTime, depth, null);
        if (r && r.type === 'return') return r.value;
        if (r && r.type === 'goto') {
            var _targetLabel = r.label;
            var _found = -1;
            for (var _gi = 0; _gi < func.body.length; _gi++) {
                if (func.body[_gi].type === 'setap' && func.body[_gi].label === _targetLabel) { _found = _gi; break; }
            }
            if (_found === -1) throw new ParserScriptError("锚点 " + _targetLabel + " 未定义");
            si = _found;
            continue;
        }
    }
    return 0;
}

// ============ 主入口 ============
export async function executeQLang(resultCodeStr, answers, otherInputs, qs) {
    try {
        var code = String(resultCodeStr || "");
        setParserWorkingDir(_currentWorkingDir);
        
        // ===== 预处理 #include 指令 =====
        // 使用循环处理，每次替换后重新扫描
        var maxIter = 100;
        var iter = 0;
        var changed = true;
        
        while (changed && iter < maxIter) {
            changed = false;
            iter++;
            
            var incMatch = code.match(/#include\s*<([^>]+)>/);
            if (!incMatch) break;
            
            var _libName = incMatch[1];
            var _fullMatch = incMatch[0];
            var _index = incMatch.index;
            
            try {
                var _libRaw = readLibraryFileSync(_libName);
                // 去掉 #defNS 和 using namespace 行
                _libRaw = _libRaw.replace(/^#defNS\s+\w+;?\s*$/gm, '').replace(/^using\s+namespace\s+\w+;?\s*$/gm, '').trim();
                code = code.substring(0, _index) + '\n' + _libRaw + '\n' + code.substring(_index + _fullMatch.length);
                changed = true;
            } catch (_ie) {
                throw new Error('脚本错误: [库: ' + _libName + '.qlg] ' + (_ie.message || String(_ie)));
            }
        }
        
        if (iter >= maxIter) {
            throw new Error('脚本错误: #include 嵌套过深（超过 ' + maxIter + ' 层）');
        }
        
        var ast = parse(code, {});
        var _resultText = executeAst(ast, answers, otherInputs, qs);
        Mem.fatDestroy();
        return { resultText: _resultText };
    } catch (e) {
        var _file = "[文件: 入口程序]";
        var _line = "";
        if (e.line) {
            _line = "[行: " + e.line + "] ";
            var _lines = code.split('\n');
            if (e.line > 0 && e.line <= _lines.length) {
                _line += "\"" + _lines[e.line - 1].trim() + "\" ";
            }
        }
        var _msg = (e.message || String(e));
        throw new Error("脚本错误: " + _file + " " + _line + _msg);
    }
}
