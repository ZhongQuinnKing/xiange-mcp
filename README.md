# xiange-mcp

弦歌 xiange — 音乐能力 MCP Server

给 AI 用的音乐能力包，通过 MCP 协议暴露六项核心工具：识谱、转谱、乐理校验、记谱规范校验、格式互转、渲染出图。

## 六工具

| 工具 | 用途 | 输入 | 输出 |
|---|---|---|---|
| `omr_read` | 识谱 | 图片／PDF | MusicXML + MIDI + run.json |
| `audio_transcribe` | 转谱 | 音频（wav/mp3/flac） | MIDI + MusicXML |
| `theory_check` | 乐理校验 | MusicXML／MIDI／krn | 校验报告（声部交叉／平行五八度／跨度） |
| `notation_check` | 记谱规范校验 | MusicXML | 校验报告（符杠／符干／休止／谱表） |
| `convert` | 格式互转＋移调 | MusicXML／MIDI／krn／mxl | 目标格式文件 |
| `render_score` | 渲染出图／PDF | MusicXML | SVG／PNG／PDF（逐页） |

统一三件套返回：`result`（结果）、`report`（校验报告）、`confidence`（置信标注）。

## 快速体验

```bash
npm run demo
# 浏览器打开 http://localhost:8080
```

复现页展示六工具能力，包含交互演示（模拟执行）与验证快速体验（输入 MusicXML → 乐理 + 记谱双校验）。

## 安装

```bash
npm install xiange-mcp
```

## 前置依赖

xiange-mcp 包装 Python 端既有工具，需要以下环境：

- Python 3.11+（miniconda env `music-transcribe`）
- xiange 工具集（默认路径 `~/.claude/skills/music-pack/tools/`）
- 可选：SMT 引擎（OMR）、Demucs + Basic Pitch / muscriptor（音频转谱）

环境变量可覆盖默认路径：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `XIANG_MCP_TOOLS` | `~/.claude/skills/music-pack/tools/` | Python 工具目录 |
| `XIANG_MCP_INTERNAL` | `~/Desktop/AI/音乐/音乐技能包-内部/` | 内部工具目录 |
| `SMT_ROOT` | `~/Desktop/AI/工具/AI工具/SMT/` | SMT 引擎仓 |
| `XIANG_MCP_PYTHON` | `python3` | Python 解释器 |

## 配置

Claude Code / Claude Desktop 的 `mcpServers` 配置示例：

```json
{
  "mcpServers": {
    "xiange-mcp": {
      "command": "npx",
      "args": ["xiange-mcp"],
      "env": {
        "XIANG_MCP_TOOLS": "/Users/you/.claude/skills/music-pack/tools",
        "XIANG_MCP_PYTHON": "/Users/you/miniconda/envs/music-transcribe/bin/python"
      }
    }
  }
}
```

## 开发

```bash
git clone https://github.com/ZhongQuinnKing/xiange-mcp
cd xiange-mcp
npm install
npm run dev          # tsx 直接跑
npm run build        # 编译到 dist/
npm start            # 跑编译产物
npm run check        # 类型检查
```

## 架构

```
Claude / MCP 客户端
  ↕ stdio (JSON-RPC)
xiange-mcp (Node.js, @modelcontextprotocol/server)
  ↕ child_process
xiange Python 工具集 (engine_runner / theory_check / notation_check / vv_render ...)
```

Node.js 层只做 MCP 协议适配与参数校验，算法全在 Python 工具里。包装不重写引擎。

## 许可证

MIT — 见 [LICENSE.md](LICENSE.md)

xiange 工具集本身另有许可，见其 [LICENSE.md](https://github.com/ZhongQuinnKing/xiange/blob/main/LICENSE.md)。

## 相关链接

- 弦歌 xiange 主仓：[github.com/ZhongQuinnKing/xiange](https://github.com/ZhongQuinnKing/xiange)
- MCP 协议：[modelcontextprotocol.io](https://modelcontextprotocol.io)