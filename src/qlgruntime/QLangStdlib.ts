// QLangStdlib — 内置标准头（非 .qlg 文件，编译时嵌入）
// @ts-nocheck

export var QLANG_STDLIB = `
// ===== Operit QLang Standard Library =====
// 内置于解释器，非外部 .qlg 文件

#defNS std

// ---- 数学 ----
int _gcd(int a, int b) { while(b){ int t=b; b=a%b; a=t; } return a; }
int parseInt(string s) { /* native */ }

// ---- 类型转换 ----
short _short(int v)    { /* native: truncate to 16-bit signed */ }
int _int(int v)        { /* native: truncate to 32-bit signed */ }
int _int32(int v)      { /* native: truncate to 32-bit signed */ }
longlong _long(int v)        { /* native: truncate to 64-bit signed */ }
longlong _longlong(int v)    { /* native: truncate to 64-bit signed */ }
longlong _int64(int v)       { /* native: truncate to 64-bit signed */ }
unsigned _uint(int v)        { /* native: zero-extend to 32-bit unsigned */ }
unsigned _unsigned(int v)    { /* native: zero-extend to 32-bit unsigned */ }

// ---- 字符串 ----
int strlen(string s)   { /* native */ }
int strcmp(string a, string b) { /* native */ }
string strcpy(string dst, string src) { /* native */ }

// ---- 输出 ----
int printf(string fmt, ...) { /* native */ }

// ---- 控制 ----
void abort(string msg) { /* native */ }
`;