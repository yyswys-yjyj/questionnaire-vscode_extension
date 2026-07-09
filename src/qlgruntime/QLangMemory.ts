// QLangMemory — 二进制内存系统
// 256MB ArrayBuffer + FAT 分配表（16MB）
// 完全抛弃 JS Number，用原始字节 + 类型编码存储所有数据
// @ts-nocheck

// ===== 常量 =====
export var MEM_SIZE = 256 * 1024 * 1024;  // 256MB
export var SLOT_SIZE = 8;                  // 每个槽位 8 bytes
export var SLOT_COUNT = MEM_SIZE / SLOT_SIZE; // 33,554,432 个槽位
export var FAT_ENTRY_SIZE = 4;             // 每个 FAT 表项 4 bytes
export var FAT_SIZE = SLOT_COUNT * FAT_ENTRY_SIZE; // 128MB

// 类型编码
export var TYPE_NULL    = 0x00;
export var TYPE_INT8    = 0x01;
export var TYPE_INT16   = 0x02;
export var TYPE_INT32   = 0x03;
export var TYPE_INT64   = 0x04;
export var TYPE_UINT8   = 0x05;
export var TYPE_UINT16  = 0x06;
export var TYPE_UINT32  = 0x07;
export var TYPE_FLOAT32 = 0x08;
export var TYPE_FLOAT64 = 0x09;
export var TYPE_BOOL    = 0x0A;
export var TYPE_CHAR    = 0x0B;
export var TYPE_PTR     = 0x0C;
export var TYPE_STRING  = 0x0D;
export var TYPE_ARRAY   = 0x0E;
export var TYPE_STRUCT  = 0x0F;

// FAT 状态
export var FAT_FREE = 0x00000000;
export var FAT_END  = 0xFFFFFFFF;
export var FAT_RESV = 0xFFFFFFFE;  // 保留（最后一项空闲标记）

// ===== 内存缓冲区（延迟初始化，每次 fatInit 重新创建以便 GC）=====
export var MEM = null;
export var MEM_U8 = null;
export var MEM_I32 = null;
export var MEM_U32 = null;
export var MEM_F32 = null;
export var MEM_F64 = null;

// FAT 表
export var FAT = null;

// 空闲链表头指针
export var freeHead = 1; // slot 0 保留给 null 指针

// ===== FAT 分配器 =====
export function fatInit() {
    // 重新创建内存，旧 ArrayBuffer 失去引用后被 GC 回收
    MEM = new ArrayBuffer(MEM_SIZE);
    MEM_U8 = new Uint8Array(MEM);
    MEM_I32 = new Int32Array(MEM);
    MEM_U32 = new Uint32Array(MEM);
    MEM_F32 = new Float32Array(MEM);
    MEM_F64 = new Float64Array(MEM);
    FAT = new Uint32Array(SLOT_COUNT);
    FAT.fill(FAT_FREE);
    FAT[0] = FAT_END; // slot 0 = null
    freeHead = 1;
}

export function fatAlloc(count) {
    if (count <= 0) throw new Error("分配大小无效");
    // next-fit 策略
    var start = -1;
    var run = 0;
    var idx = freeHead;
    var scanned = 0;
    while (scanned < SLOT_COUNT) {
        if (FAT[idx] === FAT_FREE) {
            if (run === 0) start = idx;
            run++;
            if (run >= count) {
                // 找到连续的 count 个空闲槽
                for (var i = 0; i < count - 1; i++) {
                    FAT[start + i] = start + i + 1; // 链表链接
                }
                FAT[start + count - 1] = FAT_END;     // 最后一项
                freeHead = (start + count) % SLOT_COUNT;
                if (freeHead === 0) freeHead = 1;
                return start;
            }
        } else {
            run = 0;
            start = -1;
        }
        idx = (idx + 1) % SLOT_COUNT;
        if (idx === 0) idx = 1; // 跳过 slot 0
        scanned++;
    }
    throw new Error("内存不足: 无法分配 " + count + " 个槽位");
}

export function fatFree(slot) {
    if (slot === 0) throw new Error("不能释放 null 指针");
    var next = slot;
    while (next < SLOT_COUNT && FAT[next] !== FAT_END && FAT[next] !== FAT_FREE) {
        var tmp = FAT[next];
        FAT[next] = FAT_FREE;
        next = tmp;
    }
    if (next < SLOT_COUNT) FAT[next] = FAT_FREE;
    if (slot < freeHead || freeHead === 1) freeHead = slot;
}

// ===== 类型编码到宽度映射 =====
export function typeWidth(typeCode) {
    switch (typeCode) {
        case TYPE_INT8: case TYPE_UINT8: case TYPE_BOOL: case TYPE_CHAR: return 1;
        case TYPE_INT16: case TYPE_UINT16: return 2;
        case TYPE_INT32: case TYPE_UINT32: case TYPE_FLOAT32: return 4;
        case TYPE_INT64: case TYPE_FLOAT64: case TYPE_PTR: return 8;
        default: return 8;
    }
}

export function typeNameToCode(name) {
    var map = {
        'int': TYPE_INT32, 'int32': TYPE_INT32, 'short': TYPE_INT16,
        'long': TYPE_INT32, 'longlong': TYPE_INT64, 'int64': TYPE_INT64,
        'unsigned': TYPE_UINT32, 'uint': TYPE_UINT32,
        'float': TYPE_FLOAT32, 'double': TYPE_FLOAT64,
        'char': TYPE_CHAR, 'bool': TYPE_BOOL, 'string': TYPE_STRING,
        'void': TYPE_INT32, 'auto': TYPE_INT32,
    };
    return map[name] || TYPE_INT32;
}

// 带类型后缀的名称映射（如 int[] → 数组）
export function isArrayType(name) { return name && name.endsWith('[]'); }
export function isPtrType(name) { return name && name.endsWith('*'); }

// ===== 字节级读写（小端序）=====
export function readByte(addr) { return MEM_U8[addr]; }
export function writeByte(addr, val) { MEM_U8[addr] = val & 0xFF; }

export function readInt16(addr) {
    return (MEM_U8[addr] | (MEM_U8[addr + 1] << 8)) << 16 >> 16; // 有符号扩展
}
export function writeInt16(addr, val) {
    var v = val & 0xFFFF;
    MEM_U8[addr] = v & 0xFF;
    MEM_U8[addr + 1] = (v >> 8) & 0xFF;
}

export function readUint16(addr) {
    return MEM_U8[addr] | (MEM_U8[addr + 1] << 8);
}

export function readInt32(addr) {
    var i = addr >> 2;
    return MEM_I32[i];
}
export function writeInt32(addr, val) {
    var i = addr >> 2;
    MEM_I32[i] = val;
}

export function readUint32(addr) {
    var i = addr >> 2;
    return MEM_U32[i];
}
export function writeUint32(addr, val) {
    var i = addr >> 2;
    MEM_U32[i] = val;
}

export function readFloat64(addr) {
    var i = addr >> 3;
    return MEM_F64[i];
}
export function writeFloat64(addr, val) {
    var i = addr >> 3;
    MEM_F64[i] = val;
}

// ===== 64-bit 有符号操作 =====
// JS Number 安全整数范围是 -2^53 ~ 2^53，64-bit 在范围内

// 把 64-bit 拆成两个 uint32（小端序 low:high）
export function readInt64Parts(addr) {
    var low = readUint32(addr);
    var high = readUint32(addr + 4);
    return { low: low, high: high };
}

export function writeInt64Parts(addr, low, high) {
    writeUint32(addr, low);
    writeUint32(addr + 4, high);
}

export function readInt64(addr) {
    var parts = readInt64Parts(addr);
    // JS 位运算只支持 32-bit，所以直接算
    return parts.low + parts.high * 0x100000000;
}

export function writeInt64(addr, val) {
    if (typeof val !== 'number') val = 0;
    // 回绕到 64-bit signed
    if (val > 0) {
        val = val % 0x10000000000000000;
        if (val > 0x7FFFFFFFFFFFFFFF) val -= 0x10000000000000000;
    } else if (val < 0) {
        val = val % 0x10000000000000000;
        if (val < -0x8000000000000000) val += 0x10000000000000000;
    }
    var low = (val & 0xFFFFFFFF) >>> 0;
    var high = Math.floor(val / 0x100000000) & 0xFFFFFFFF;
    writeInt64Parts(addr, low, high);
}

export function readUint64(addr) {
    var parts = readInt64Parts(addr);
    return (parts.low >>> 0) + parts.high * 0x100000000;
}

// ===== 指针操作 =====
// 指针结构：槽位内 8 bytes = 目标地址(uint48) + 目标类型(uint8) + 标志(uint8)
// 但简化实现：指针槽 = 目标地址(uint32)

export function readPtr(addr) {
    return readUint32(addr);
}
export function writePtr(addr, target) {
    writeUint32(addr, target & 0xFFFFFFFF);
}

// ===== 字符串操作 =====
// 字符串存储：头部 8 bytes (length uint32 + capacity uint32) + UTF-8 字节序列
// 槽位内 8 bytes 存字节区域的起始地址

export function readStringHeader(addr) {
    var byteAddr = readUint32(addr);
    if (byteAddr === 0) return { length: 0, capacity: 0, bytes: new Uint8Array(0) };
    var length = readUint32(byteAddr);       // 字符数
    var capacity = readUint32(byteAddr + 4); // 容量（字符数）
    var bytes = new Uint8Array(MEM, byteAddr + 8, length * 2); // UTF-16: 每字符 2 字节
    return { length: length, capacity: capacity, bytes: bytes, byteAddr: byteAddr };
}

export function writeString(addr, str) {
    str = String(str || '');
    // 直接按 UTF-16 charCode 存储，每个字符 2 字节（小端序）
    // 不依赖 TextEncoder/UTF-8 编码
    var len = str.length;
    var cap = Math.max(len, 4);
    cap = (cap + 3) & ~3;
    // 释放旧数据
    var oldByteAddr = readUint32(addr);
    if (oldByteAddr !== 0) {
        // 简化：不回收旧的
    }
    // 分配新内存：头部 8 字节（length+capacity） + 每个字符 2 字节
    var byteSlots = Math.ceil((8 + cap * 2) / SLOT_SIZE);
    var newSlot = fatAlloc(byteSlots);
    var byteAddr = newSlot * SLOT_SIZE;
    writeUint32(addr, byteAddr);
    writeUint32(byteAddr, len);
    writeUint32(byteAddr + 4, cap);
    for (var wi = 0; wi < len; wi++) {
        var code = str.charCodeAt(wi);
        MEM_U8[byteAddr + 8 + wi * 2] = code & 0xFF;
        MEM_U8[byteAddr + 8 + wi * 2 + 1] = (code >> 8) & 0xFF;
    }
}
export function readString(addr) {
    var header = readStringHeader(addr);
    if (header.bytes.length === 0) return '';
    // 直接按 UTF-16 读取（不依赖 TextDecoder）
    var _bytes = header.bytes;
    var result = '';
    var count = header.length;
    for (var si = 0; si < count; si++) {
        var lo = _bytes[si * 2];
        var hi = _bytes[si * 2 + 1];
        if (hi === undefined) hi = 0;
        result += String.fromCharCode(lo | (hi << 8));
    }
    return result;
}

// ===== 通用读/写（根据类型编码）=====
export function readValue(addr, typeCode) {
    switch (typeCode) {
        case TYPE_INT8:   return readByte(addr) << 24 >> 24;
        case TYPE_INT16:  return readInt16(addr);
        case TYPE_INT32:  return readInt32(addr);
        case TYPE_INT64:  return readInt64(addr);
        case TYPE_UINT8:  return readByte(addr);
        case TYPE_UINT16: return readUint16(addr);
        case TYPE_UINT32: return readUint32(addr);
        case TYPE_FLOAT32: return MEM_F32[addr >> 2];
        case TYPE_FLOAT64: return readFloat64(addr);
        case TYPE_BOOL:   return readByte(addr) !== 0;
        case TYPE_CHAR:   return String.fromCharCode(readByte(addr));
        case TYPE_PTR:    return readPtr(addr);
        case TYPE_STRING: return readString(addr);
        default: return readInt32(addr);
    }
}

export function writeValue(addr, typeCode, value) {
    switch (typeCode) {
        case TYPE_INT8:   writeByte(addr, value); break;
        case TYPE_INT16:  writeInt16(addr, value); break;
        case TYPE_INT32:  writeInt32(addr, value); break;
        case TYPE_INT64:  writeInt64(addr, value); break;
        case TYPE_UINT8:  writeByte(addr, value); break;
        case TYPE_UINT16: writeInt16(addr, value); break;
        case TYPE_UINT32: writeUint32(addr, value); break;
        case TYPE_FLOAT32: MEM_F32[addr >> 2] = value; break;
        case TYPE_FLOAT64: writeFloat64(addr, value); break;
        case TYPE_BOOL:   writeByte(addr, value ? 1 : 0); break;
        case TYPE_CHAR:   writeByte(addr, typeof value === 'string' ? value.charCodeAt(0) : value); break;
        case TYPE_PTR:    writePtr(addr, value); break;
        case TYPE_STRING: writeString(addr, value); break;
        default: writeInt32(addr, value); break;
    }
}

// ===== 类型边界 & 溢出检查 =====
export function typeBounds(typeCode) {
    switch (typeCode) {
        case TYPE_INT8:   return { min: -128, max: 127, signed: true, width: 1 };
        case TYPE_INT16:  return { min: -32768, max: 32767, signed: true, width: 2 };
        case TYPE_INT32:  return { min: -2147483648, max: 2147483647, signed: true, width: 4 };
        case TYPE_INT64:  return { min: -9007199254740992, max: 9007199254740992, signed: true, width: 8 };
        case TYPE_UINT8:  return { min: 0, max: 255, signed: false, width: 1 };
        case TYPE_UINT16: return { min: 0, max: 65535, signed: false, width: 2 };
        case TYPE_UINT32: return { min: 0, max: 4294967295, signed: false, width: 4 };
        default: return { min: -Infinity, max: Infinity, signed: true, width: 4 };
    }
}

// 补码运算：回绕截断
export function twosComplement(val, bits) {
    // 对于 32 位：先用 >>> 0 取低 32 位无符号值，再转有符号
    if (bits >= 32) {
        var v = (val >>> 0); // 低 32 位无符号
        if (v & 0x80000000) {
            v = v - 0x100000000; // 符号扩展
        }
        return v;
    }
    var mask = (1 << bits) - 1;
    var v = val & mask;
    var signBit = 1 << (bits - 1);
    if (v & signBit) {
        v = v - (1 << bits);
    }
    return v;
}

// 溢出检查（仅记录，不抛异常，保留回绕行为）
export function checkOverflow(a, b, result, typeCode) {
    // 回绕本身就是补码的预期行为，不做额外处理
}

// 补码加法
export function twosAdd(a, b, typeCode) {
    var bounds = typeBounds(typeCode);
    var bits = bounds.width * 8;
    var result = twosComplement(a + b, bits);
    checkOverflow(a, b, result, typeCode);
    return result;
}

// 补码减法
export function twosSub(a, b, typeCode) {
    return twosAdd(a, -b, typeCode);
}

// 补码乘法
export function twosMul(a, b, typeCode) {
    var bounds = typeBounds(typeCode);
    var bits = bounds.width * 8;
    return twosComplement(a * b, bits);
}

// 补码除法
export function twosDiv(a, b, typeCode) {
    if (b === 0) throw new Error("除零");
    var bounds = typeBounds(typeCode);
    var bits = bounds.width * 8;
    return twosComplement(Math.trunc(a / b), bits);
}

// ===== STL 容器操作（纯二进制） =====
// 容器内存布局：[类型标记(4B) | 大小(4B) | 容量(4B) | 数据区(容量个槽位)]
// 头部占 3 个槽位，数据从第 3 个槽位开始
export var STL_HEAD_SLOTS = 3;
export var STL_DEFAULT_CAP = 32;

// 创建容器，返回 baseAddr
export function stlCreate(type) {
    var cap = STL_DEFAULT_CAP;
    var slots = STL_HEAD_SLOTS + cap; // 头部 + 数据区
    var baseSlot = fatAlloc(slots);
    var baseAddr = baseSlot * SLOT_SIZE;
    writeInt32(baseAddr, type);           // 类型标记
    writeInt32(baseAddr + 4, 0);           // 大小 = 0
    writeInt32(baseAddr + 8, cap);         // 容量
    // 数据槽位初始化为 0
    for (var _si = 0; _si < cap; _si++) {
        writeInt32(baseAddr + (_si + STL_HEAD_SLOTS) * SLOT_SIZE, 0);
    }
    return baseAddr;
}
// 获取容器大小
export function stlSize(addr) {
    return readInt32(addr + 4);
}
// 获取容器容量
export function stlCapacity(addr) {
    return readInt32(addr + 8);
}
// 获取容器数据槽位索引
export function stlDataIndex(addr, idx) {
    return addr + (idx + STL_HEAD_SLOTS) * SLOT_SIZE;
}
// 读取容器数据
export function stlRead(addr, idx) {
    return readInt32(stlDataIndex(addr, idx));
}
// 写入容器数据
export function stlWrite(addr, idx, val) {
    writeInt32(stlDataIndex(addr, idx), val);
}
// 容器 push（末尾添加）
export function stlPush(addr, val) {
    var sz = stlSize(addr);
    var cap = stlCapacity(addr);
    if (sz >= cap) return; // 满则不操作
    stlWrite(addr, sz, val);
    writeInt32(addr + 4, sz + 1);
}
// 容器 pop（移除末尾）
export function stlPop(addr) {
    var sz = stlSize(addr);
    if (sz <= 0) return;
    writeInt32(addr + 4, sz - 1);
}
// 容器 top（读取末尾）
export function stlTop(addr) {
    var sz = stlSize(addr);
    if (sz <= 0) return 0;
    return stlRead(addr, sz - 1);
}
// 容器 front（读取开头）
export function stlFront(addr) {
    if (stlSize(addr) <= 0) return 0;
    return stlRead(addr, 0);
}
// 容器 back（读取末尾，同 top）
export function stlBack(addr) {
    return stlTop(addr);
}
// 容器 empty
export function stlEmpty(addr) {
    return stlSize(addr) === 0;
}
// pair first/second（读写，有参数时写入，无参数时读取）
export function stlFirst(addr, val) {
    if (arguments.length >= 2) { writeInt32(addr, val); return val; }
    return readInt32(addr);
}
export function stlSecond(addr, val) {
    if (arguments.length >= 2) { writeInt32(addr + 4, val); return val; }
    return readInt32(addr + 4);
}

// ===== 初始化 =====
fatInit();

// ==== 销毁内存（供外部调用，释放物理内存引用）====
export function fatDestroy() {
    MEM = null;
    MEM_U8 = null;
    MEM_I32 = null;
    MEM_U32 = null;
    MEM_F32 = null;
    MEM_F64 = null;
    FAT = null;
    freeHead = 1;
}
// 保留 slot 0 作为 null
FAT[0] = FAT_END;