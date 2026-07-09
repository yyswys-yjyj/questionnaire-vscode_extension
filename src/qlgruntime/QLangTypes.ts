// QLangTypes — 类型编码、边界、关键字、默认值
// @ts-nocheck
import * as Mem from './QLangMemory';
export var TYPE_BOUNDS = {
    'short': { min: -32768, max: 32767, width: 2, signed: true },
    'int': { min: -2147483648, max: 2147483647, width: 4, signed: true },
    'int32': { min: -2147483648, max: 2147483647, width: 4, signed: true },
    'long': { min: -2147483648, max: 2147483647, width: 4, signed: true },
    'int64': { min: -9007199254740992, max: 9007199254740992, width: 8, signed: true },
    'longlong': { min: -9007199254740992, max: 9007199254740992, width: 8, signed: true },
    'unsigned': { min: 0, max: 4294967295, width: 4, signed: false },
    'uint': { min: 0, max: 4294967295, width: 4, signed: false },
    'float': { width: 4, signed: true, isFloat: true },
    'double': { width: 8, signed: true, isFloat: true },
    'char': { width: 1, signed: false },
    'string': { width: 0 },
    'bool': { width: 1 },
};

export var TYPE_KEYWORDS = {
    'int': true, 'float': true, 'double': true, 'char': true, 'string': true, 'bool': true,
    'stack': true, 'queue': true, 'vector': true, 'pair': true, 'priority_queue': true,
    'short': true, 'long': true, 'unsigned': true, 'longlong': true,
    'int64': true, 'uint': true, 'int32': true,
};

export var TOKENIZER_KEYWORDS = { 'int': true, 'float': true, 'double': true, 'char': true, 'string': true, 'bool': true,
    'true': true, 'false': true, 'if': true, 'else': true, 'while': true, 'for': true,
    'return': true, 'void': true, 'const': true, 'break': true, 'continue': true,
    'stack': true, 'queue': true, 'vector': true, 'pair': true, 'priority_queue': true,
    'struct': true, 'new': true, 'try': true, 'catch': true, 'throw': true,
    'short': true, 'long': true, 'unsigned': true, 'longlong': true,
    'int64': true, 'uint': true, 'int32': true,
    'typedef': true, 'setap': true, 'gotoap': true };

export function resolveType(name, typeAliases) {
    return (typeAliases && typeAliases[name]) || name;
}

export function isTypeLike(v, typeAliases) {
    return TYPE_KEYWORDS[v] || (typeAliases && typeAliases[v]);
}

export function defaultValue(type) {
    if (type === 'stack' || type === 'queue' || type === 'vector' || type === 'priority_queue') {
        return Mem.stlCreate(type);
    }
    if (type === 'pair') { var _pSlot = Mem.fatAlloc(2); return _pSlot * Mem.SLOT_SIZE; }
    var map = { 'int': 0, 'float': 0.0, 'double': 0.0, 'char': '', 'string': '', 'bool': false, 'void': 0,
        'short': 0, 'long': 0, 'unsigned': 0, 'longlong': 0, 'int64': 0, 'uint': 0, 'int32': 0 };
    return map[type] !== undefined ? map[type] : 0;
}

export function clampValue(value, type) {
    if (typeof value !== 'number') return value;
    var bounds = TYPE_BOUNDS[type];
    if (bounds && !bounds.isFloat) {
        value = Math.round(value);
        if (value < bounds.min) value = bounds.min;
        if (value > bounds.max) value = bounds.max;
    }
    return value;
}
