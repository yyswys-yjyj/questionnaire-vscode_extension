import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { executeQLang, setQLangWorkingDir, ScriptError } from './QLangInterpreter';

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

// ============ QLang 调试适配器 ============
class QLangDebugAdapter implements vscode.DebugAdapter {
    private _onDidSendMessage = new vscode.EventEmitter<vscode.DebugProtocolMessage>();
    readonly onDidSendMessage = this._onDidSendMessage.event;

    private _filePath: string = '';
    private _breakpoints: Map<number, boolean> = new Map();
    private _isRunning: boolean = false;
    private _pauseResolve: (() => void) | null = null;
    private _isPaused: boolean = false;
    private _outputChannel: vscode.OutputChannel;
    private _currentBreakpointLine: number = 0;  // 记录当前断点行号

    constructor() {
        this._outputChannel = getOutputChannel();
    }

    handleMessage(message: vscode.DebugProtocolMessage): void {
        const msg = message as any;
        switch (msg.command) {
            case 'launch':
                this._handleLaunch(msg);
                break;
            case 'configurationDone':
                this._sendResponse(msg, {});
                break;
            case 'setBreakpoints':
                this._handleSetBreakpoints(msg);
                break;
            case 'threads':
                this._handleThreads(msg);
                break;
            case 'stackTrace':          // VSCode 断点暂停后会请求调用栈
                this._handleStackTrace(msg);
                break;
            case 'scopes':              // VSCode 断点暂停后会请求变量作用域
                this._handleScopes(msg);
                break;
            case 'continue':
                this._handleContinue(msg);
                break;
            case 'next':
                this._handleNext(msg);
                break;
            case 'stepIn':
                this._handleStepIn(msg);
                break;
            case 'stepOut':
                this._handleStepOut(msg);
                break;
            case 'pause':
                this._handlePause(msg);
                break;
            case 'disconnect':
                this._handleDisconnect(msg);
                break;
            default:
                this._sendResponse(msg, {});
        }
    }

    // ============ 线程请求 ============
    private _handleThreads(msg: any): void {
        this._sendResponse(msg, {
            threads: [
                {
                    id: 1,
                    name: 'Main Thread'
                }
            ]
        });
    }

    // ============ 调用栈请求（关键！断点暂停后 VSCode 会请求这个） ============
    private _handleStackTrace(msg: any): void {
        // 构造一个栈帧，指向当前断点所在的行
        const frame = {
            id: 1,
            name: 'main',
            source: {
                path: this._filePath,
                name: path.basename(this._filePath)
            },
            line: this._currentBreakpointLine || 1,
            column: 1
        };

        this._sendResponse(msg, {
            stackFrames: [frame],
            totalFrames: 1
        });
    }

    // ============ 变量作用域请求 ============
    private _handleScopes(msg: any): void {
        this._sendResponse(msg, {
            scopes: [
                {
                    name: 'Local',
                    presentationHint: 'locals',
                    variablesReference: 0,
                    expensive: false,
                    source: {
                        path: this._filePath
                    },
                    line: this._currentBreakpointLine || 1,
                    column: 1
                }
            ]
        });
    }

    // ============ 启动调试 ============
    private _handleLaunch(msg: any): void {
        const filePath = msg.arguments?.program;
        
        if (!filePath || !fs.existsSync(filePath)) {
            this._sendErrorResponse(msg, `[Fail] 文件不存在: ${filePath || '未指定'}`);
            return;
        }
        
        this._filePath = filePath;
        
        const channel = getOutputChannel();
        channel.clear();
        channel.appendLine(`[Info] 调试: ${path.basename(this._filePath)}`);
        channel.appendLine('─'.repeat(50));
        channel.show();

        this._sendResponse(msg, {});
        this._sendEvent('initialized', {});
        
        setTimeout(() => {
            this._runScript();
        }, 100);
    }

    // ============ 执行脚本 ============
    private async _runScript(): Promise<void> {
        if (this._isRunning) return;
        this._isRunning = true;

        try {
            const code = fs.readFileSync(this._filePath, 'utf8');
            const workDir = path.dirname(this._filePath);
            setQLangWorkingDir(workDir);
            
            const breakpointLines = Array.from(this._breakpoints.keys()).sort((a, b) => a - b);
            
            if (breakpointLines.length > 0) {
                const lines = code.split('\n');
                let hitCount = 0;
                
                for (const lineNum of breakpointLines) {
                    if (lineNum < 1 || lineNum > lines.length) {
                        this._outputChannel.appendLine(`[Warning] 断点行 ${lineNum} 超出文件范围`);
                        continue;
                    }
                    
                    hitCount++;
                    this._currentBreakpointLine = lineNum;  // 记录断点行号
                    this._outputChannel.appendLine(`[Info] 断点命中: 第 ${lineNum} 行 (${hitCount}/${breakpointLines.length})`);
                    this._outputChannel.appendLine(`  ${lines[lineNum - 1].trim()}`);
                    this._outputChannel.appendLine('─'.repeat(40));
                    
                    // 暂停并等待用户继续
                    this._isPaused = true;
                    this._sendEvent('stopped', { 
                        reason: 'breakpoint',
                        threadId: 1 
                    });
                    await new Promise<void>((resolve) => {
                        this._pauseResolve = resolve;
                    });
                    this._isPaused = false;
                }
                
                if (hitCount > 0) {
                    this._outputChannel.appendLine(`[Info] 所有断点已命中 (${hitCount} 个)`);
                    this._sendEvent('continued', { allThreadsContinued: true });
                }
            }

            // 执行脚本
            const answers: Record<string, string> = {};
            const questions: any[] = [];
            for (let i = 1; i <= 10; i++) {
                const id = 'q' + i;
                answers[id] = '';
                questions.push({ id, type: 'text' });
            }

            const result = await executeQLang(code, answers, {}, questions);
            
            if (result) {
                this._outputChannel.appendLine(result);
            } else {
                this._outputChannel.appendLine('[Success] 执行成功（无输出）');
            }
            this._outputChannel.appendLine('─'.repeat(50));
            this._outputChannel.appendLine('[Success] 调试完成');
            
            this._sendEvent('exited', { exitCode: 0 });
            this._sendEvent('terminated', {});
            
        } catch (err: any) {
            const errMsg = err instanceof ScriptError ? err.message : String(err.message || err);
            this._outputChannel.appendLine('[Fail] ' + errMsg);
            this._outputChannel.appendLine('─'.repeat(50));
            this._outputChannel.appendLine('[Fail] 调试失败');
            
            this._sendEvent('exited', { exitCode: 1 });
            this._sendEvent('terminated', {});
        }
        
        this._isRunning = false;
    }

    // ============ 设置断点 ============
    private _handleSetBreakpoints(msg: any): void {
        const args = msg.arguments;
        this._breakpoints.clear();
        
        if (args.breakpoints) {
            for (const bp of args.breakpoints) {
                this._breakpoints.set(bp.line, true);
            }
            const lines = Array.from(this._breakpoints.keys()).sort((a, b) => a - b);
            if (lines.length > 0) {
                this._outputChannel.appendLine(`[Info] 已设置 ${lines.length} 个断点: 行 ${lines.join(', ')}`);
            }
        }
        
        this._sendResponse(msg, { breakpoints: args.breakpoints || [] });
    }

    // ============ 继续执行 ============
    private _handleContinue(msg: any): void {
        this._sendResponse(msg, { allThreadsContinued: true });
        if (this._isPaused && this._pauseResolve) {
            const resolve = this._pauseResolve;
            this._pauseResolve = null;
            this._isPaused = false;
            resolve();
        }
    }

    // ============ 单步跳过 ============
    private _handleNext(msg: any): void {
        this._sendResponse(msg, {});
        if (this._isPaused && this._pauseResolve) {
            const resolve = this._pauseResolve;
            this._pauseResolve = null;
            this._isPaused = false;
            resolve();
        }
    }

    // ============ 单步进入 ============
    private _handleStepIn(msg: any): void {
        this._sendResponse(msg, {});
        if (this._isPaused && this._pauseResolve) {
            const resolve = this._pauseResolve;
            this._pauseResolve = null;
            this._isPaused = false;
            resolve();
        }
    }

    // ============ 单步跳出 ============
    private _handleStepOut(msg: any): void {
        this._sendResponse(msg, {});
        if (this._isPaused && this._pauseResolve) {
            const resolve = this._pauseResolve;
            this._pauseResolve = null;
            this._isPaused = false;
            resolve();
        }
    }

    // ============ 暂停 ============
    private _handlePause(msg: any): void {
        this._sendResponse(msg, {});
        if (!this._isPaused) {
            this._isPaused = true;
            this._sendEvent('stopped', { reason: 'pause', threadId: 1 });
        }
    }

    // ============ 断开连接 ============
    private _handleDisconnect(msg: any): void {
        this._sendResponse(msg, {});
        if (this._isPaused && this._pauseResolve) {
            const resolve = this._pauseResolve;
            this._pauseResolve = null;
            this._isPaused = false;
            resolve();
        }
        this._sendEvent('terminated', {});
    }

    // ============ 发送响应 ============
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

    // ============ 发送错误响应 ============
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

    // ============ 发送事件 ============
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

// ============ 自动补全 ============
class QLangCompletionProvider implements vscode.CompletionItemProvider {
    provideCompletionItems(
        _document: vscode.TextDocument,
        _position: vscode.Position,
        _token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.CompletionItem[]> {
        const items: vscode.CompletionItem[] = [];

        const keywords = [
            'int', 'float', 'double', 'char', 'string', 'bool', 'void',
            'if', 'else', 'while', 'for', 'return',
            'const', 'break', 'continue',
            'struct', 'new',
            'stack', 'queue', 'vector', 'pair', 'priority_queue',
            'try', 'catch', 'throw',
            'using', 'namespace',
            'true', 'false'
        ];

        for (const kw of keywords) {
            items.push(new vscode.CompletionItem(kw, vscode.CompletionItemKind.Keyword));
        }

        const funcs = ['printf', 'cout', 'print', 'sizeof', 'size', 'strlen', 'strcmp', 'strcpy', '_gcd', 'parseInt', 'abort', 'main'];
        for (const fn of funcs) {
            const item = new vscode.CompletionItem(fn, vscode.CompletionItemKind.Function);
            if (fn === 'printf') {
                item.insertText = 'printf("${1:message}\\n"${2:, });';
            } else if (fn === 'cout') {
                item.insertText = 'cout << "${1:message}" << endl;';
            } else if (fn === 'main') {
                item.insertText = 'int main(int qid) {\n    ${1:// code}\n    return 0;\n}';
            }
            items.push(item);
        }

        return items;
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
        'stack': '栈容器 (LIFO)',
        'queue': '队列容器 (FIFO)',
        'vector': '动态数组容器',
        'pair': '键值对容器',
        'priority_queue': '优先队列 (大顶堆)',
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
        'strcpy': '复制字符串'
    };

    provideHover(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.Hover> {
        const wordRange = document.getWordRangeAtPosition(position);
        if (!wordRange) return null;
        
        const word = document.getText(wordRange);
        const info = this.docMap[word];
        
        if (info) {
            const content = new vscode.MarkdownString(`**${word}**\n\n${info}`);
            content.supportHtml = true;
            return new vscode.Hover(content, wordRange);
        }
        return null;
    }
}

// ============ 激活函数 ============
export function activate(context: vscode.ExtensionContext) {
    console.log('[Info] QLang 插件已激活！');

    globalOutputChannel = vscode.window.createOutputChannel('QLang');

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
            
            const answers: Record<string, string> = {};
            const questions: any[] = [];
            for (let i = 1; i <= 10; i++) {
                const id = 'q' + i;
                answers[id] = '';
                questions.push({ id, type: 'text' });
            }
            
            const result = await executeQLang(code, answers, {}, questions);
            outputChannel.appendLine(result || '[Success] 执行成功（无输出）');
            outputChannel.appendLine('─'.repeat(50));
            outputChannel.appendLine('[Success] 执行完成');
        } catch (err: any) {
            outputChannel.appendLine('[Fail] ' + (err.message || String(err)));
            outputChannel.appendLine('─'.repeat(50));
            outputChannel.appendLine('[Fail] 执行失败');
            vscode.window.showErrorMessage('[Fail] QLang 执行失败: ' + (err.message || String(err)));
        }
    });
    context.subscriptions.push(runCommand);

    // 2. 注册调试适配器工厂
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
    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider('qlang', new QLangCompletionProvider())
    );

    // 5. 注册 Hover 提示
    context.subscriptions.push(
        vscode.languages.registerHoverProvider('qlang', new QLangHoverProvider())
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