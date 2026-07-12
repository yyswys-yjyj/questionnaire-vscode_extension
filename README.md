# questionnaire-vscode_extension
面向QLang Lib开发者的Microsoft VSCode扩展
适用版本：v1.7.x

## 1.安装
从release中下载最新的发行版，然后打开Microsoft Visual Studio Code，进入“扩展（Ctrl+Shift+X）”，然后点击搜索框旁边三个点（视图和更多操作...），选择“从 VSIX 安装...”，选择下载的扩展包，然后安装即可

## 2.功能
该扩展包除了对qlg文件增加语法高亮、括号配对与自动缩进、补全以外，还适配了运行时和断点调试

## 3.使用
### 3.1 运行调试
要运行调试，你需要创建`launch.json`
#### 3.1.1 手动创建 launch.json
如果你需要手动创建，假设你的文件树如下：
```
.
├── main.qlg
└── example.qlg
```

你需要创建 `.vscode`文件夹，然后在该文件夹下创建一个`launch.json`文件，此时你的树会变成：
```
.
├── main.qlg
├── example.qlg
└── .vscode
    └── launch.json
```
#### 3.1.2 通过 VSCode 创建 launch.json
进入“运行和调试（Ctrl+Shift+D）”，点击“创建一个 launch.json 文件”即可


无论你使用那种方法创建，确保文件内容为：
```json
{
    "configurations": [
    
        {
            "name": "QLang: Run File",
            "type": "qlang",
            "request": "launch",
            "program": "${workspaceFolder}/main.qlg",
            "stopOnEntry": false
        }
    ]
}
```
你需要关注的是`program`键，它代表着整个程序的入口，即主文件
主文件需要遵循 [questionnaire](https://github.com/yyswys-yjyj/questionnaire) 中的规范

### 3.2 断点调试
暂时砍掉了这个功能

### 3.3 关于qid
这个版本忘做了...
