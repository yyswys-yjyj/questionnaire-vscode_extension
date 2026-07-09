import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { executeQLang, setQLangWorkingDir, ScriptError, parse } from './qlgruntime/index';
import { setParserWorkingDir } from './qlgruntime/QLangParser';

// ============ 全局持久化输出通道 ============
let globalOutputChannel: vscode.OutputChannel | null = null;

function getOutputChannel(): vscode.OutputChannel {
    if (!globalOutputChannel) {
        globalOutputChannel = vscode.window.createOutputChannel('QLang');
    }
    return globalOutputChannel;
}

function clearAndShowOutput(): vscode.OutputChannel {
    const channel = getOutputChannel();
    channel.clear();
    channel.show();
    return channel;
}

// ============ 外部库缓存（用于补全和悬停）============
interface LibraryInfo {
    name: string;
    path: string;
    functions: { name: string; returnType: string; params: string; docComment?: string }[];
    docComment?: string;
    namespaces: string[];
}

class LibraryManager {
    private _cache: Map<string, LibraryInfo> = new Map();
    private _workspaceRoot: string = '';

    constructor() {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (workspaceFolder) {
            this._workspaceRoot = workspaceFolder.uri.fsPath;
        }
    }

    setWorkspaceRoot(root: string) {
        this._workspaceRoot = root;
    }

    async scanLibraries(): Promise<string[]> {
        if (!this._workspaceRoot) {
            return [];
        }
        
        const libFiles: string[] = [];
        const searchDirs = [
            path.join(this._workspaceRoot, 'library'),
            this._workspaceRoot
        ];

        for (const dir of searchDirs) {
            if (fs.existsSync(dir)) {
                const files = fs.readdirSync(dir);
                for (const file of files) {
                    if (file.endsWith('.qlg')) {
                        const libName = file.replace(/\.qlg$/, '');
                        const fullPath = path.join(dir, file);
                        libFiles.push(libName);
                        this._cacheLibrary(libName, fullPath);
                    }
                }
            }
        }
        
        return libFiles;
    }

    private _cacheLibrary(libName: string, filePath: string): void {
        try {
            const content = fs.readFileSync(filePath, 'utf8');
            const info: LibraryInfo = {
                name: libName,
                path: filePath,
                functions: [],
                namespaces: [],
                docComment: this._extractFileDocComment(content)
            };

            const nsMatches = content.match(/#defNS\s+(\w+)/g);
            if (nsMatches) {
                for (const ns of nsMatches) {
                    const match = ns.match(/#defNS\s+(\w+)/);
                    if (match) {
                        info.namespaces.push(match[1]);
                    }
                }
            }
            if (info.namespaces.length === 0) {
                info.namespaces.push('qlgstd');
            }

            const funcRegex = /\/\*\*([\s\S]*?)\*\/\s*(?:static\s+)?(int|float|double|char|string|bool|void)\s+(\w+)\s*\(([^)]*)\)\s*\{/g;
            let match;
            while ((match = funcRegex.exec(content)) !== null) {
                const docComment = match[1].trim();
                const returnType = match[2];
                const funcName = match[3];
                const params = match[4].trim();
                
                info.functions.push({
                    name: funcName,
                    returnType: returnType,
                    params: params || 'void',
                    docComment: this._parseDoxygenComment(docComment)
                });
            }

            const funcRegex2 = /(int|float|double|char|string|bool|void)\s+(\w+)\s*\(([^)]*)\)\s*\{/g;
            let match2;
            while ((match2 = funcRegex2.exec(content)) !== null) {
                const returnType = match2[1];
                const funcName = match2[2];
                const params = match2[3].trim();
                if (!info.functions.some(f => f.name === funcName)) {
                    info.functions.push({
                        name: funcName,
                        returnType: returnType,
                        params: params || 'void',
                        docComment: undefined
                    });
                }
            }

            this._cache.set(libName, info);
            this._cache.set(filePath, info);
        } catch (e) {
            // 忽略解析错误
        }
    }

    private _extractFileDocComment(content: string): string | undefined {
        const match = content.match(/\/\*\*([\s\S]*?)\*\/\s*#defNS/);
        if (match) {
            return this._parseDoxygenComment(match[1].trim());
        }
        return undefined;
    }

    private _parseDoxygenComment(comment: string): string {
        const lines = comment.split('\n');
        const result: string[] = [];
        let brief = '';
        let params: string[] = [];
        let returns = '';

        for (const line of lines) {
            const trimmed = line.replace(/^\s*\*\s*/, '').trim();
            if (trimmed.startsWith('@brief')) {
                brief = trimmed.replace('@brief', '').trim();
                result.push(`**简要说明**: ${brief}`);
            } else if (trimmed.startsWith('@param')) {
                const paramMatch = trimmed.match(/@param\s+(\w+)\s+(.+)/);
                if (paramMatch) {
                    params.push(`**@param** ${paramMatch[1]}: ${paramMatch[2]}`);
                }
            } else if (trimmed.startsWith('@return') || trimmed.startsWith('@returns')) {
                returns = trimmed.replace(/@returns?/, '').trim();
                result.push(`**返回值**: ${returns}`);
            } else if (trimmed.startsWith('@note')) {
                result.push(`**注意**: ${trimmed.replace('@note', '').trim()}`);
            } else if (trimmed.startsWith('@warning')) {
                result.push(`**⚠️ 警告**: ${trimmed.replace('@warning', '').trim()}`);
            } else if (!trimmed.startsWith('@') && trimmed.length > 0 && !result.some(r => r.includes('简要说明'))) {
                if (!brief) {
                    result.push(`**说明**: ${trimmed}`);
                }
            }
        }

        for (const p of params) {
            result.push(p);
        }

        return result.join('\n\n') || '无详细文档';
    }

    getLibrary(name: string): LibraryInfo | undefined {
        return this._cache.get(name);
    }

    getAllLibraryNames(): string[] {
        return Array.from(this._cache.keys()).filter(k => !k.includes(path.sep));
    }

    getAllLibraries(): LibraryInfo[] {
        return Array.from(this._cache.values());
    }
}

const libraryManager = new LibraryManager();

// ============ 语法检查器（诊断提供者）============
class QLangDiagnosticProvider {
    private _diagnosticCollection: vscode.DiagnosticCollection;

    constructor() {
        this._diagnosticCollection = vscode.languages.createDiagnosticCollection('qlang');
    }

    // 更新文档诊断
    public updateDiagnostics(document: vscode.TextDocument): void {
        
        const filePath = document.uri.fsPath;
        const workDir = path.dirname(filePath);
        setParserWorkingDir(workDir);
        

        if (document.languageId !== 'qlang') {
            return;
        }

        const diagnostics: vscode.Diagnostic[] = [];

        try {
            const code = document.getText();
            // 尝试解析代码
            const ast = parse(code, {});
            
            // 解析成功：遍历 AST 查找弃用语法
            this._checkDeprecated(ast, diagnostics, document);
        } catch (err: any) {
            // 解析失败：生成错误诊断
            const lineMatch = err.message?.match(/第(\d+)行/);
            const line = lineMatch ? parseInt(lineMatch[1]) - 1 : 0;
            const range = new vscode.Range(line, 0, line, 0);
            const diagnostic = new vscode.Diagnostic(
                range,
                err.message || '解析错误',
                vscode.DiagnosticSeverity.Error
            );
            diagnostics.push(diagnostic);
        }

        this._diagnosticCollection.set(document.uri, diagnostics);
    }

    // 递归遍历 AST，查找弃用语法
    private _checkDeprecated(ast: any, diagnostics: vscode.Diagnostic[], document: vscode.TextDocument): void {
        if (!ast) return;

        // 遍历 globalStmts
        if (ast.globalStmts) {
            for (const stmt of ast.globalStmts) {
                this._walkNode(stmt, diagnostics, document);
            }
        }

        // 遍历函数定义中的函数体
        if (ast.namespaces) {
            for (const ns in ast.namespaces) {
                const nsObj = ast.namespaces[ns];
                if (nsObj.functions) {
                    for (const fname in nsObj.functions) {
                        const func = nsObj.functions[fname];
                        if (func.body) {
                            for (const stmt of func.body) {
                                this._walkNode(stmt, diagnostics, document);
                            }
                        }
                    }
                }
            }
        }
    }

    private _walkNode(node: any, diagnostics: vscode.Diagnostic[], document: vscode.TextDocument): void {
        if (!node) return;

        // 检查 arrowAccess 节点，且 ptr 为 'qid'
        if (node.type === 'arrowAccess' && node.ptr === 'qid') {
            const line = node.line || 0;
            const range = new vscode.Range(line, 0, line + 1, 0);
            const diagnostic = new vscode.Diagnostic(
                range,
                'qid-> 语法已弃用，请使用 qid. 访问结构体成员',
                vscode.DiagnosticSeverity.Warning
            );
            diagnostics.push(diagnostic);
        }

        // 递归遍历子节点
        for (const key in node) {
            const child = node[key];
            if (child && typeof child === 'object') {
                if (Array.isArray(child)) {
                    for (const item of child) {
                        this._walkNode(item, diagnostics, document);
                    }
                } else {
                    this._walkNode(child, diagnostics, document);
                }
            }
        }
    }

    // 清理
    public dispose(): void {
        this._diagnosticCollection.dispose();
    }
}

// ============ QLang 调试适配器（砍掉断点，退化为运行）============
class QLangDebugAdapter implements vscode.DebugAdapter {
    private _onDidSendMessage = new vscode.EventEmitter<vscode.DebugProtocolMessage>();
    readonly onDidSendMessage = this._onDidSendMessage.event;

    private _filePath: string = '';
    private _outputChannel: vscode.OutputChannel;

    constructor() {
        this._outputChannel = getOutputChannel();
    }

    handleMessage(message: vscode.DebugProtocolMessage): void {
        const msg = message as any;
        switch (msg.command) {
            case 'launch':
                this._handleLaunch(msg);
                break;
            case 'disconnect':
                this._handleDisconnect(msg);
                break;
            default:
                this._sendResponse(msg, {});
        }
    }

    private _handleLaunch(msg: any): void {
        const filePath = msg.arguments?.program;
        
        if (!filePath || !fs.existsSync(filePath)) {
            this._sendErrorResponse(msg, `[Fail] 文件不存在: ${filePath || '未指定'}`);
            return;
        }
        
        this._filePath = filePath;
        
        const workDir = path.dirname(filePath);
        setQLangWorkingDir(workDir);
        libraryManager.setWorkspaceRoot(workDir);
        libraryManager.scanLibraries();
        
        const channel = getOutputChannel();
        channel.clear();
        channel.appendLine(`[Info] 调试（运行模式）: ${path.basename(this._filePath)}`);
        channel.appendLine('─'.repeat(50));
        channel.show();

        this._sendResponse(msg, {});
        this._sendEvent('initialized', {});
        
        setTimeout(() => {
            this._runScript();
        }, 100);
    }

    private async _runScript(): Promise<void> {
        try {
            const code = fs.readFileSync(this._filePath, 'utf8');
            const workDir = path.dirname(this._filePath);
            setQLangWorkingDir(workDir);

            const answers: Record<string, string> = {};
            const questions: any[] = [];
            for (let i = 1; i <= 10; i++) {
                const id = 'q' + i;
                answers[id] = '';
                questions.push({ id, type: 'text' });
            }

            const result = await executeQLang(code, answers, {}, questions);
            
            if (result && result.resultText) {
                this._outputChannel.appendLine(result.resultText);
            } else {
                this._outputChannel.appendLine('[Success] 执行成功（无输出）');
            }
            this._outputChannel.appendLine('─'.repeat(50));
            this._outputChannel.appendLine('[Success] 执行完成');
            
            this._sendEvent('exited', { exitCode: 0 });
            this._sendEvent('terminated', {});
            
        } catch (err: any) {
            const errMsg = (err as any).message || String(err);
            this._outputChannel.appendLine('[Fail] ' + errMsg);
            this._outputChannel.appendLine('─'.repeat(50));
            this._outputChannel.appendLine('[Fail] 调试失败');
            
            this._sendEvent('exited', { exitCode: 1 });
            this._sendEvent('terminated', {});
        }
    }

    private _handleDisconnect(msg: any): void {
        this._sendResponse(msg, {});
        this._sendEvent('terminated', {});
    }

    private _sendResponse(msg: any, body: any): void {
        this._onDidSendMessage.fire({
            type: 'response',
            request_seq: msg.seq,
            command: msg.command,
            seq: Date.now(),
            body: body,
            success: true
        } as any);
    }

    private _sendErrorResponse(msg: any, error: string): void {
        this._onDidSendMessage.fire({
            type: 'response',
            request_seq: msg.seq,
            command: msg.command,
            seq: Date.now(),
            body: { error: error },
            success: false
        } as any);
    }

    private _sendEvent(event: string, body: any): void {
        this._onDidSendMessage.fire({
            type: 'event',
            event: event,
            body: body,
            seq: Date.now()
        } as any);
    }

    dispose(): void {
        this._onDidSendMessage.dispose();
    }
}

// ============ 调试工厂 ============
class QLangDebugAdapterFactory implements vscode.DebugAdapterDescriptorFactory {
    createDebugAdapterDescriptor(
        _session: vscode.DebugSession,
        _executable: vscode.DebugAdapterExecutable | undefined
    ): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
        return new vscode.DebugAdapterInlineImplementation(new QLangDebugAdapter());
    }
}

// ============ 调试配置提供者 ============
class QLangDebugConfigurationProvider implements vscode.DebugConfigurationProvider {
    resolveDebugConfiguration(
        folder: vscode.WorkspaceFolder | undefined,
        config: vscode.DebugConfiguration,
        _token?: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.DebugConfiguration> {
        if (config.type !== 'qlang') {
            return config;
        }

        if (!config.program) {
            vscode.window.showErrorMessage('[Fail] launch.json 中缺少 "program" 字段');
            return undefined;
        }

        let programPath = config.program;
        
        const workspaceFolder = folder || vscode.workspace.workspaceFolders?.[0];
        if (workspaceFolder) {
            const workspacePath = workspaceFolder.uri.fsPath;
            programPath = programPath.replace(/\$\{workspaceFolder\}/g, workspacePath);
            programPath = programPath.replace(/\$\{workspaceRoot\}/g, workspacePath);
            
            const editor = vscode.window.activeTextEditor;
            if (editor) {
                const filePath = editor.document.uri.fsPath;
                programPath = programPath.replace(/\$\{file\}/g, filePath);
                const basename = path.basename(filePath);
                programPath = programPath.replace(/\$\{fileBasename\}/g, basename);
            }
        }

        if (!fs.existsSync(programPath)) {
            vscode.window.showErrorMessage(`[Fail] 文件不存在: ${programPath}`);
            return undefined;
        }

        return {
            ...config,
            program: programPath
        };
    }
}

// ============ 智能补全 ============
class QLangCompletionProvider implements vscode.CompletionItemProvider {
    provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.CompletionItem[]> {
        const items: vscode.CompletionItem[] = [];
        const linePrefix = document.lineAt(position).text.substr(0, position.character);
        const text = document.getText();

        // #include < 补全
        const includeMatch = linePrefix.match(/#include\s*<(\w*)$/);
        if (includeMatch) {
            const partial = includeMatch[1];
            libraryManager.scanLibraries();
            const libNames = libraryManager.getAllLibraryNames();
            
            for (const libName of libNames) {
                if (libName.startsWith(partial) || partial === '') {
                    const item = new vscode.CompletionItem(libName, vscode.CompletionItemKind.Module);
                    item.insertText = libName + '>';
                    item.filterText = libName;
                    item.detail = `外部库: ${libName}.qlg`;
                    const libInfo = libraryManager.getLibrary(libName);
                    if (libInfo && libInfo.docComment) {
                        item.documentation = new vscode.MarkdownString(
                            `**库: ${libName}.qlg**\n\n${libInfo.docComment}\n\n` +
                            `**导出函数**: ${libInfo.functions.length} 个\n` +
                            `**命名空间**: ${libInfo.namespaces.join(', ')}`
                        );
                    } else {
                        item.documentation = new vscode.MarkdownString(
                            `**库: ${libName}.qlg**\n\n从外部库导入函数和命名空间。`
                        );
                    }
                    items.push(item);
                }
            }
            return items;
        }

        // 注释中的 Doxygen 标签补全
        const isInComment = this._isInComment(document, position);
        if (isInComment) {
            const doxygenTags = [
                '@param', '@return', '@returns', '@brief', '@description',
                '@var', '@arg', '@note', '@warning', '@see', '@author',
                '@date', '@version', '@since', '@deprecated', '@todo',
                '@bug', '@example', '@code', '@endcode'
            ];
            for (const tag of doxygenTags) {
                const item = new vscode.CompletionItem(tag, vscode.CompletionItemKind.Keyword);
                item.detail = 'Doxygen 标签';
                items.push(item);
            }
            
            const paramMatch = linePrefix.match(/@param\s+(\w*)$/);
            if (paramMatch) {
                const funcParams = this._extractFunctionParams(text, position);
                for (const p of funcParams) {
                    const item = new vscode.CompletionItem(p, vscode.CompletionItemKind.Variable);
                    item.detail = '函数参数';
                    items.push(item);
                }
            }
            return items;
        }

        // 关键字
        const keywords = [
            'int', 'float', 'double', 'char', 'string', 'bool', 'void',
            'if', 'else', 'while', 'for', 'return',
            'const', 'break', 'continue',
            'struct', 'new',
            'stack', 'queue', 'vector', 'pair', 'priority_queue',
            'try', 'catch', 'throw',
            'using', 'namespace',
            'true', 'false', 'null', 'auto',
            'short', 'long', 'unsigned', 'longlong', 'int64', 'uint', 'int32',
            'typedef', 'setap', 'gotoap'
        ];

        for (const kw of keywords) {
            const item = new vscode.CompletionItem(kw, vscode.CompletionItemKind.Keyword);
            item.detail = 'QLang 关键字';
            items.push(item);
        }

        // 内置函数
        const builtins = [
            { label: 'printf', snippet: 'printf("${1:message}\\n"${2:, });', detail: '格式化输出' },
            { label: 'cout', snippet: 'cout << "${1:message}" << endl;', detail: '流式输出' },
            { label: 'print', snippet: 'print(${1:value});', detail: '多参数输出' },
            { label: 'sizeof', snippet: 'sizeof(${1:array});', detail: '获取数组长度' },
            { label: 'size', snippet: 'size(${1:container});', detail: '获取容器大小' },
            { label: 'strlen', snippet: 'strlen(${1:string});', detail: '获取字符串长度' },
            { label: 'strcmp', snippet: 'strcmp(${1:str1}, ${2:str2});', detail: '比较字符串' },
            { label: 'strcpy', snippet: 'strcpy(${1:dst}, ${2:src});', detail: '复制字符串' },
            { label: '_gcd', snippet: '_gcd(${1:a}, ${2:b});', detail: '最大公约数' },
            { label: 'parseInt', snippet: 'parseInt(${1:str});', detail: '字符串转整数' },
            { label: 'abort', snippet: 'abort("${1:message}");', detail: '立即终止脚本' },
            { label: 'main', snippet: 'int main(int qid) {\n    ${1:// code}\n    return 0;\n}', detail: '程序入口' }
        ];

        for (const fn of builtins) {
            const item = new vscode.CompletionItem(fn.label, vscode.CompletionItemKind.Function);
            item.insertText = fn.snippet;
            item.detail = fn.detail;
            items.push(item);
        }

        // 外部库函数补全
        libraryManager.scanLibraries();
        const allLibs = libraryManager.getAllLibraries();
        for (const lib of allLibs) {
            for (const func of lib.functions) {
                if (this._isFunctionDefinedInDocument(text, func.name)) {
                    continue;
                }
                const item = new vscode.CompletionItem(
                    func.name, 
                    vscode.CompletionItemKind.Function
                );
                item.detail = `${func.returnType} ${func.name}(${func.params})`;
                item.insertText = func.name;
                let docString = `**从库 ${lib.name}.qlg 导入**\n\n`;
                docString += `**返回值**: \`${func.returnType}\`\n`;
                docString += `**参数**: \`${func.params}\`\n`;
                if (func.docComment) {
                    docString += `\n${func.docComment}`;
                }
                item.documentation = new vscode.MarkdownString(docString);
                items.push(item);

                for (const ns of lib.namespaces) {
                    const nsItem = new vscode.CompletionItem(
                        `${ns}::${func.name}`,
                        vscode.CompletionItemKind.Function
                    );
                    nsItem.detail = `${func.returnType} ${func.name}(${func.params}) (${ns}::)`;
                    nsItem.insertText = `${ns}::${func.name}`;
                    nsItem.documentation = new vscode.MarkdownString(
                        `**命名空间**: ${ns}\n` +
                        `**函数**: ${func.returnType} ${func.name}(${func.params})`
                    );
                    items.push(nsItem);
                }
            }
        }

        // 代码片段快捷补全
        const snippetMap: Record<string, { snippet: string; label: string; detail: string }> = {
            'for': { snippet: 'for (int i = 0; i < ${1:10}; i++) {\n    ${0}\n}', label: 'for loop', detail: 'for 循环' },
            'if': { snippet: 'if (${1:condition}) {\n    ${0}\n}', label: 'if statement', detail: 'if 条件判断' },
            'else': { snippet: 'else {\n    ${0}\n}', label: 'else statement', detail: 'else 分支' },
            'while': { snippet: 'while (${1:condition}) {\n    ${0}\n}', label: 'while loop', detail: 'while 循环' },
            'struct': { snippet: 'struct ${1:Name} {\n    ${2:int field};\n};', label: 'struct definition', detail: '结构体定义' },
            'try': { snippet: 'try {\n    ${0}\n} catch (e) {\n    \n}', label: 'try-catch', detail: '异常捕获' }
        };

        for (const [trigger, info] of Object.entries(snippetMap)) {
            if (linePrefix.endsWith(trigger) || linePrefix.match(new RegExp(`\\b${trigger}$`))) {
                const item = new vscode.CompletionItem(info.label, vscode.CompletionItemKind.Snippet);
                item.insertText = info.snippet;
                item.filterText = trigger;
                item.detail = info.detail;
                item.range = new vscode.Range(
                    position.translate(0, -trigger.length),
                    position
                );
                items.push(item);
            }
        }

        return items;
    }

    private _isInComment(document: vscode.TextDocument, position: vscode.Position): boolean {
        const line = document.lineAt(position.line).text;
        const textBefore = line.substring(0, position.character);
        if (textBefore.includes('//')) return true;
        const startIndex = textBefore.lastIndexOf('/*');
        const endIndex = textBefore.lastIndexOf('*/');
        if (startIndex > endIndex) return true;
        return false;
    }

    private _extractFunctionParams(text: string, position: vscode.Position): string[] {
        const params: string[] = [];
        const lines = text.split('\n');
        const currentLine = position.line;
        for (let i = currentLine; i >= 0 && i >= currentLine - 20; i--) {
            const line = lines[i];
            const match = line.match(/^\s*(?:int|float|double|char|string|bool|void)\s+(\w+)\s*\(([^)]*)\)/);
            if (match) {
                const paramStr = match[2].trim();
                if (paramStr) {
                    const parts = paramStr.split(',');
                    for (const p of parts) {
                        const trimmed = p.trim();
                        const nameMatch = trimmed.match(/\s*(\w+)\s*$/);
                        if (nameMatch) {
                            params.push(nameMatch[1]);
                        }
                    }
                }
                break;
            }
        }
        return params;
    }

    private _isFunctionDefinedInDocument(text: string, funcName: string): boolean {
        const regex = new RegExp(`\\b${funcName}\\s*\\(`, 'g');
        return regex.test(text);
    }
}

// ============ Hover 提示 ============
class QLangHoverProvider implements vscode.HoverProvider {
    private docMap: Record<string, string> = {
        'printf': '格式化输出，支持 %d(整数), %s(字符串), %x(十六进制), %o(八进制), %p(指针)',
        'cout': '流式输出，使用 << 连接，支持 endl 换行',
        'print': '多参数输出，逗号分隔，自动添加空格',
        'int': '32位整数类型',
        'float': '单精度浮点数',
        'double': '双精度浮点数',
        'char': '字符类型',
        'string': '字符串类型',
        'bool': '布尔类型 (true/false)',
        'void': '无返回值',
        'if': '条件判断',
        'else': '否则分支',
        'while': '循环执行',
        'for': '计数循环',
        'return': '返回值',
        'const': '只读常量',
        'break': '退出循环',
        'continue': '跳过本次循环',
        'struct': '结构体定义',
        'new': '创建结构体实例',
        'stack': '栈容器 (LIFO)，容量 1000',
        'queue': '队列容器 (FIFO)，容量 1000',
        'vector': '动态数组容器',
        'pair': '键值对容器',
        'priority_queue': '优先队列 (大顶堆)，容量 1000',
        'try': '异常捕获尝试',
        'catch': '捕获异常',
        'throw': '抛出异常',
        'abort': '立即终止脚本并报错',
        '_gcd': '计算最大公约数',
        'parseInt': '字符串转整数',
        'size': '获取容器大小',
        'sizeof': '获取数组长度',
        'strlen': '获取字符串长度',
        'strcmp': '比较两个字符串',
        'strcpy': '复制字符串',
        'using': '使用命名空间',
        'namespace': '命名空间声明',
        'true': '布尔真值',
        'false': '布尔假值',
        'null': '空指针',
        '#include': '导入外部库文件\n用法: #include <库名>',
        'short': '16位有符号整数',
        'long': '32位有符号整数（同 int）',
        'unsigned': '32位无符号整数',
        'longlong': '64位有符号整数',
        'int64': '64位有符号整数',
        'uint': '32位无符号整数',
        'int32': '32位有符号整数',
        'typedef': '类型别名定义',
        'setap': '设置锚点（配合 gotoap）',
        'gotoap': '跳转到指定锚点'
    };

    provideHover(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.Hover> {
        const wordRange = document.getWordRangeAtPosition(position);
        if (!wordRange) return null;
        
        const word = document.getText(wordRange);
        const line = document.lineAt(position.line).text;
        const textBefore = line.substring(0, position.character);

        // #include 悬停
        const includeMatch = line.match(/#include\s*<([^>]+)>/);
        if (includeMatch) {
            const libName = includeMatch[1];
            const libInfo = libraryManager.getLibrary(libName);
            if (libInfo) {
                let content = `**库: ${libName}.qlg**\n\n`;
                if (libInfo.docComment) {
                    content += `${libInfo.docComment}\n\n`;
                }
                content += `**导出函数** (${libInfo.functions.length} 个):\n`;
                for (const func of libInfo.functions) {
                    content += `- \`${func.returnType} ${func.name}(${func.params})\`\n`;
                }
                content += `\n**命名空间**: ${libInfo.namespaces.join(', ')}`;
                const md = new vscode.MarkdownString(content);
                md.supportHtml = true;
                return new vscode.Hover(md, wordRange);
            }
            return new vscode.Hover(`**库: ${libName}.qlg**\n\n文件未找到。`);
        }

        // 注释中的 Doxygen 标签
        const isInComment = textBefore.includes('//') || 
                           (textBefore.includes('/*') && !textBefore.includes('*/'));
        if (isInComment && word.startsWith('@')) {
            const doxygenDoc: Record<string, string> = {
                '@param': '参数说明标签\n用法: @param name description',
                '@return': '返回值说明标签\n用法: @return description',
                '@returns': '返回值说明标签\n用法: @returns description',
                '@brief': '简要说明标签\n用法: @brief description',
                '@description': '详细描述标签\n用法: @description text',
                '@var': '变量说明标签\n用法: @var name description',
                '@arg': '参数说明标签 (同 @param)',
                '@note': '注意事项标签\n用法: @note text',
                '@warning': '警告标签\n用法: @warning text',
                '@see': '参见标签\n用法: @see reference',
                '@author': '作者标签\n用法: @author name',
                '@date': '日期标签\n用法: @date date',
                '@version': '版本标签\n用法: @version version',
                '@since': '版本起始标签\n用法: @since version',
                '@deprecated': '弃用标签\n用法: @deprecated reason',
                '@todo': '待办标签\n用法: @todo task',
                '@bug': 'Bug 标签\n用法: @bug description',
                '@example': '示例标签\n用法: @example code',
                '@code': '代码块开始\n用法: @code ... @endcode',
                '@endcode': '代码块结束'
            };
            if (doxygenDoc[word]) {
                const content = new vscode.MarkdownString(`**${word}**\n\n${doxygenDoc[word]}`);
                content.supportHtml = true;
                return new vscode.Hover(content, wordRange);
            }
        }

        // 关键字提示
        if (this.docMap[word]) {
            const content = new vscode.MarkdownString(`**${word}**\n\n${this.docMap[word]}`);
            content.supportHtml = true;
            return new vscode.Hover(content, wordRange);
        }

        // 函数定义
        const fullLine = line.trim();
        if (fullLine.includes('(') && fullLine.includes(')')) {
            const funcMatch = fullLine.match(/^\s*(int|float|double|char|string|bool|void)\s+(\w+)\s*\(([^)]*)\)/);
            if (funcMatch) {
                const returnType = funcMatch[1];
                const funcName = funcMatch[2];
                const params = funcMatch[3].trim() || 'void';
                const content = new vscode.MarkdownString(
                    `**函数定义**\n\n` +
                    `返回值: \`${returnType}\`\n` +
                    `函数名: \`${funcName}\`\n` +
                    `参数: \`${params}\``
                );
                content.supportHtml = true;
                return new vscode.Hover(content, wordRange);
            }
        }

        return null;
    }
}

// ============ 激活函数 ============
export function activate(context: vscode.ExtensionContext) {
    console.log('[Info] QLang 插件已激活！');

    globalOutputChannel = vscode.window.createOutputChannel('QLang');

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (workspaceFolder) {
        libraryManager.setWorkspaceRoot(workspaceFolder.uri.fsPath);
        libraryManager.scanLibraries();
    }

    // 1. 运行命令 (Ctrl+Shift+Q)
    const runCommand = vscode.commands.registerCommand('qlang.run', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage('[Fail] 没有活动的编辑器');
            return;
        }
        
        const document = editor.document;
        const filePath = document.uri.fsPath;
        
        if (!filePath.endsWith('.qlg')) {
            vscode.window.showErrorMessage('[Fail] 当前文件不是 .qlg 文件');
            return;
        }
        
        const outputChannel = clearAndShowOutput();
        outputChannel.appendLine(`[Info] 正在运行: ${path.basename(filePath)}`);
        outputChannel.appendLine('─'.repeat(50));
        
        try {
            const code = document.getText();
            const workDir = path.dirname(filePath);
            setQLangWorkingDir(workDir);
            libraryManager.setWorkspaceRoot(workDir);
            libraryManager.scanLibraries();
            
            const answers: Record<string, string> = {};
            const questions: any[] = [];
            for (let i = 1; i <= 10; i++) {
                const id = 'q' + i;
                answers[id] = '';
                questions.push({ id, type: 'text' });
            }
            
            const result = await executeQLang(code, answers, {}, questions);
            
            if (result && result.resultText) {
                outputChannel.appendLine(result.resultText);
            } else {
                outputChannel.appendLine('[Success] 执行成功（无输出）');
            }
            outputChannel.appendLine('─'.repeat(50));
            outputChannel.appendLine('[Success] 执行完成');
        } catch (err: any) {
            const errMsg = (err as any).message || String(err);
            outputChannel.appendLine('[Fail] ' + errMsg);
            outputChannel.appendLine('─'.repeat(50));
            outputChannel.appendLine('[Fail] 执行失败');
            vscode.window.showErrorMessage('[Fail] QLang 执行失败: ' + errMsg);
        }
    });
    context.subscriptions.push(runCommand);

    // 2. 注册调试适配器工厂（砍掉断点，退化为运行）
    const debugFactory = new QLangDebugAdapterFactory();
    context.subscriptions.push(
        vscode.debug.registerDebugAdapterDescriptorFactory('qlang', debugFactory)
    );

    // 3. 注册调试配置提供者
    const debugConfigProvider = new QLangDebugConfigurationProvider();
    context.subscriptions.push(
        vscode.debug.registerDebugConfigurationProvider('qlang', debugConfigProvider)
    );

    // 4. 注册自动补全
    const completionProvider = new QLangCompletionProvider();
    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider('qlang', completionProvider)
    );

    // 5. 注册 Hover 提示
    const hoverProvider = new QLangHoverProvider();
    context.subscriptions.push(
        vscode.languages.registerHoverProvider('qlang', hoverProvider)
    );

    // 6. 注册代码折叠
    context.subscriptions.push(
        vscode.languages.registerFoldingRangeProvider('qlang', {
            provideFoldingRanges(document: vscode.TextDocument): vscode.FoldingRange[] {
                const ranges: vscode.FoldingRange[] = [];
                const stack: { line: number }[] = [];
                for (let i = 0; i < document.lineCount; i++) {
                    const line = document.lineAt(i).text.trim();
                    if (line.includes('{')) {
                        stack.push({ line: i });
                    }
                    if (line.includes('}')) {
                        if (stack.length > 0) {
                            const start = stack.pop();
                            if (start && i > start.line + 1) {
                                ranges.push(new vscode.FoldingRange(start.line, i));
                            }
                        }
                    }
                }
                return ranges;
            }
        })
    );

    // 7. 诊断提供者（语法检查）
    const diagnosticProvider = new QLangDiagnosticProvider();
    context.subscriptions.push(diagnosticProvider);

    // 监听文档打开/变更，更新诊断
    const updateDiagnostics = (doc: vscode.TextDocument) => {
        if (doc.languageId === 'qlang') {
            diagnosticProvider.updateDiagnostics(doc);
        }
    };

    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument(updateDiagnostics),
        vscode.workspace.onDidChangeTextDocument(e => updateDiagnostics(e.document)),
        vscode.workspace.onDidSaveTextDocument(updateDiagnostics)
    );

    // 初始更新所有已打开的 qlang 文档
    for (const doc of vscode.workspace.textDocuments) {
        if (doc.languageId === 'qlang') {
            diagnosticProvider.updateDiagnostics(doc);
        }
    }

    // 8. 监听库文件变化
    const watcher = vscode.workspace.createFileSystemWatcher('**/*.qlg');
    watcher.onDidChange(() => {
        libraryManager.scanLibraries();
        // 重新检查所有打开的文档
        for (const doc of vscode.workspace.textDocuments) {
            if (doc.languageId === 'qlang') {
                diagnosticProvider.updateDiagnostics(doc);
            }
        }
    });
    watcher.onDidCreate(() => {
        libraryManager.scanLibraries();
    });
    watcher.onDidDelete(() => {
        libraryManager.scanLibraries();
    });
    context.subscriptions.push(watcher);

    context.subscriptions.push({
        dispose: () => {
            if (globalOutputChannel) {
                globalOutputChannel.dispose();
                globalOutputChannel = null;
            }
        }
    });

    vscode.window.showInformationMessage('Ctrl+Shift+Q 运行当前文件，F5 调试 (需配置 launch.json)。\n有关launch.json的内容，请前往: https://github.com/yyswys-yjyj/questionnaire-vscode_extension');
}

export function deactivate() {
    console.log('[Info] QLang 插件已停用');
    if (globalOutputChannel) {
        globalOutputChannel.dispose();
        globalOutputChannel = null;
    }
}