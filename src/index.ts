#!/usr/bin/env node
/**
 * xiange-mcp — 弦歌音乐能力 MCP Server
 *
 * 六工具：omr_read / audio_transcribe / theory_check / notation_check / convert / render_score
 * 统一三件套返回：result（结果）/ report（校验报告）/ confidence（置信标注）
 * 纪律：包装不重写引擎（全子进程调用既有 Python 工具）；判不了的明写判不了。
 *
 * 运行：npx xiange-mcp   （stdio；挂进 Claude/其他 MCP 客户端由配置指路）
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";

import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";

// ── 路径与环境 ──────────────────────────────────────────────

const HOME = os.homedir();
const TOOLS =
  process.env.XIANG_MCP_TOOLS ||
  path.join(HOME, "xiange/tools");
const INTERNAL = process.env.XIANG_MCP_INTERNAL || "";
const SMT_ROOT = process.env.SMT_ROOT || "";
const PY = process.env.XIANG_MCP_PYTHON || "python3";

// ── 工具函数 ────────────────────────────────────────────────

interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
  elapsedSec: number;
  error?: string;
}

function run(cmd: string[], opts: { timeout?: number; env?: Record<string, string>; cwd?: string } = {}): Promise<RunResult> {
  const t0 = performance.now();
  const timeout = opts.timeout ?? 300_000; // 默认 5 分钟
  const env = { ...process.env, ...opts.env };

  return new Promise((resolve) => {
    const [bin, ...args] = cmd;
    const child = spawn(bin!, args, {
      env,
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      timeout,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

    child.on("close", (code) => {
      resolve({
        ok: code === 0 || code === 1,
        stdout,
        stderr,
        code,
        elapsedSec: Math.round((performance.now() - t0) / 100) / 10,
      });
    });

    child.on("error", (err) => {
      resolve({
        ok: false,
        stdout,
        stderr,
        code: null,
        elapsedSec: Math.round((performance.now() - t0) / 100) / 10,
        error: err.message,
      });
    });
  });
}

function ensureOutDir(inputPath: string, outDir?: string): string {
  const out =
    outDir ||
    path.join(path.dirname(path.resolve(inputPath)), "_e1_out");
  if (!existsSync(out)) {
    mkdirSync(out, { recursive: true });
  }
  return out;
}

function three(
  ok: boolean,
  result: Record<string, unknown> = {},
  report: Record<string, unknown> = {},
  confidence: Record<string, unknown> = {},
  error?: string,
) {
  const d: Record<string, unknown> = { ok, result, report, confidence };
  if (error) d.error = error;
  return { content: [{ type: "text" as const, text: JSON.stringify(d, null, 2) }] };
}

// ── Server 初始化 ───────────────────────────────────────────

const server = new McpServer({
  name: "xiange-mcp",
  version: "0.1.0",
});

// ── 工具 1: omr_read ────────────────────────────────────────

server.registerTool(
  "omr_read",
  {
    description:
      "识谱：图片或 PDF → MusicXML（双引擎：smt 印刷体在役、homr 备位；auto＝按在役表选 smt）。产物留 run.json 引擎痕迹。",
    inputSchema: z.object({
      input: z.string().describe("图片或 PDF 的本地路径"),
      engine: z.enum(["smt", "homr", "auto"]).default("auto").describe("auto＝按引擎在役表选（现为 smt）"),
      out_dir: z.string().default("").describe("产物目录（可选）"),
      want_midi: z.boolean().default(true).describe("另出 MIDI（music21 转）"),
    }),
  },
  async ({ input, engine, out_dir, want_midi }) => {
    if (!existsSync(input)) {
      return three(false, {}, {}, {}, "输入不存在: " + input);
    }
    const eng = engine === "auto" ? "smt" : engine;
    const out = ensureOutDir(input, out_dir || undefined);
    const r = await run(
      [PY, path.join(TOOLS, "engine_runner.py"), input, "--engine", eng, "--out", out],
      { timeout: 1_200_000, env: { SMT_ROOT, SMT_PY: process.env.SMT_PY || "python3" } },
    );
    if (!r.ok) {
      return three(false, {}, {}, { engine: eng }, r.error || `引擎退出码 ${r.code}`);
    }
    const xml = path.join(out, eng + ".musicxml");
    if (!existsSync(xml)) {
      return three(false, {}, {}, { engine: eng, elapsed_sec: r.elapsedSec }, "引擎未产出 musicxml");
    }
    const result: Record<string, unknown> = { musicxml: xml, run_json: null, midi: null };
    if (want_midi) {
      // MIDI 转出由 Python 侧 music21 处理；这里标记期望
      result._midi_note = "MIDI conversion handled by Python engine_runner when want_midi=true";
    }
    return three(true, result, {}, {
      engine: eng,
      elapsed_sec: r.elapsedSec,
      degraded_note: "整页直喂有已知退化风险（行级为正道）",
    });
  },
);

// ── 工具 2: audio_transcribe ────────────────────────────────

server.registerTool(
  "audio_transcribe",
  {
    description:
      "转谱：音频 → MIDI／乐谱。basic_pitch 快档（秒级）；muscriptor 准档（慢，约 35 倍实时，权重 CC BY-NC 非商用）。stems=true 先 demucs 分轨。",
    inputSchema: z.object({
      input: z.string().describe("音频文件本地路径（wav／mp3／flac）"),
      engine: z.enum(["basic_pitch", "muscriptor"]).default("basic_pitch"),
      stems: z.boolean().default(false).describe("先 Demucs 分轨再逐音转写"),
      out_dir: z.string().default("").describe("产物目录（可选）"),
    }),
  },
  async ({ input, engine, stems, out_dir }) => {
    if (!existsSync(input)) {
      return three(false, {}, {}, {}, "输入不存在: " + input);
    }
    const chainScript = process.env.XIANG_MCP_AUDIO_CHAIN ||
      (INTERNAL ? path.join(INTERNAL, "E1_mcp", "transcribe_chain.py") : "");
    if (!chainScript) {
      return three(false, {}, {}, {}, "audio_transcribe 编排脚本未配置（需 XIANG_MCP_AUDIO_CHAIN 环境变量）");
    }
    const cmd = [PY, chainScript, input, "--engine", engine, "--want-xml"];
    if (stems) cmd.push("--stems");
    if (out_dir) cmd.push("--out", out_dir);
    const r = await run(cmd, { timeout: 3_600_000 });
    if (!r.ok) {
      return three(false, {}, {}, { engine }, r.error || "转谱编排失败");
    }
    const lastLine = r.stdout.trim().split("\n").pop() || "{}";
    let j: Record<string, unknown> = {};
    try {
      j = JSON.parse(lastLine);
    } catch {
      return three(false, {}, {}, { engine }, "编排输出不可解析");
    }
    const conf: Record<string, unknown> = {
      engine,
      elapsed_sec: r.elapsedSec,
    };
    if (engine === "muscriptor") {
      conf.license_note = "muscriptor 权重 CC BY-NC（非商用）";
    }
    if (!j.ok) {
      return three(false, j, {}, conf, (j.error as string) || "编排失败");
    }
    return three(
      true,
      { midi: j.midi, musicxml: j.musicxml, stems_dir: j.stems_dir },
      {},
      conf,
    );
  },
);

// ── 工具 3: theory_check ────────────────────────────────────

server.registerTool(
  "theory_check",
  {
    description:
      "乐理校验：声部交叉、平行五八度、跨度等三关（E／W 规则族）。span 可调跨度上限（半音，缺省 20＝大十三度）。",
    inputSchema: z.object({
      input: z.string().describe("musicxml／mid／krn 本地路径"),
      span: z.number().int().default(0).describe("跨度上限（半音），缺省 20＝大十三度"),
      json_out: z.string().default("").describe("报告 json 落盘路径（可选）"),
    }),
  },
  async ({ input, span, json_out }) => {
    if (!existsSync(input)) {
      return three(false, {}, {}, {}, "输入不存在: " + input);
    }
    const out = ensureOutDir(input);
    const jp = json_out || path.join(out, "theory_check.json");
    const cmd = [PY, path.join(TOOLS, "theory_check.py"), input, "--json", jp];
    if (span) cmd.push("--span", String(span));
    const r = await run(cmd, { timeout: 300_000 });
    if (!r.ok) {
      return three(false, {}, {}, {}, r.error || `退出码 ${r.code}`);
    }
    // 读取 JSON 报告
    let issues: unknown[] = [];
    if (existsSync(jp)) {
      try {
        const raw = await import("node:fs/promises").then((fs) => fs.readFile(jp, "utf-8"));
        const data = JSON.parse(raw);
        issues = Array.isArray(data) ? data : (data.issues || data);
      } catch { /* ignore parse errors */ }
    }
    return three(
      true,
      { issues, report_text: r.stdout.slice(-2000), json: jp },
      { issue_count: Array.isArray(issues) ? issues.length : "?" },
      { elapsed_sec: r.elapsedSec },
    );
  },
);

// ── 工具 4: notation_check ──────────────────────────────────

server.registerTool(
  "notation_check",
  {
    description:
      "记谱规范校验：符杠、符干、休止、谱表四关。fix=true 时同口径跑修复（改前自动备份、明细照列；默认关）。",
    inputSchema: z.object({
      input: z.string().describe("musicxml 本地路径"),
      json_out: z.string().default("").describe("报告 json 落盘路径（可选）"),
      fix: z.boolean().default(false).describe("true 时同口径跑 notation_fix（改前备份、明细照列）"),
    }),
  },
  async ({ input, json_out, fix }) => {
    if (!existsSync(input)) {
      return three(false, {}, {}, {}, "输入不存在: " + input);
    }
    const out = ensureOutDir(input);
    const jp = json_out || path.join(out, "notation_check.json");
    const r = await run(
      [PY, path.join(TOOLS, "notation_check.py"), input, "--json", jp],
      { timeout: 300_000 },
    );
    if (!r.ok) {
      return three(false, {}, {}, {}, r.error || `退出码 ${r.code}`);
    }
    let issues: unknown[] = [];
    if (existsSync(jp)) {
      try {
        const raw = await import("node:fs/promises").then((fs) => fs.readFile(jp, "utf-8"));
        const data = JSON.parse(raw);
        issues = Array.isArray(data) ? data : (data.issues || data);
      } catch { /* ignore */ }
    }
    let fixOutput: string | null = null;
    const notes: string[] = [];
    if (fix) {
      const { copyFileSync } = await import("node:fs");
      const inputBase = path.basename(input, path.extname(input));
      const fixed = path.join(out, inputBase + "_fixed.musicxml");
      copyFileSync(input, fixed);
      const jf = path.join(out, "notation_fix.json");
      const rf = await run(
        [PY, path.join(TOOLS, "notation_fix.py"), fixed, "--json", jf],
        { timeout: 300_000 },
      );
      if (!rf.ok) {
        notes.push("fix 未成: " + (rf.error || String(rf.code)));
      } else {
        fixOutput = fixed;
        notes.push(`fix 完成 ${rf.elapsedSec}s（副本上原地改，原文件未动）`);
      }
    }
    return three(
      true,
      { issues, report_text: r.stdout.slice(-2000), json: jp, fix_output: fixOutput },
      { issue_count: Array.isArray(issues) ? issues.length : "?", notes },
      { elapsed_sec: r.elapsedSec },
    );
  },
);

// ── 工具 5: convert ─────────────────────────────────────────

server.registerTool(
  "convert",
  {
    description:
      "格式互转＋移调：musicxml／mxl／midi／krn 互转；transpose 给目标调（如 G、Ab-4）则先移调（音数守恒断言）。",
    inputSchema: z.object({
      input: z.string().describe("输入文件本地路径"),
      to: z.enum(["musicxml", "mxl", "midi", "krn"]).describe("目标格式"),
      transpose: z.string().default("").describe("目标调或显式位移，如 G／Ab-4（可选）"),
      out_dir: z.string().default("").describe("产物目录（可选）"),
    }),
  },
  async ({ input, to, transpose, out_dir }) => {
    if (!existsSync(input)) {
      return three(false, {}, {}, {}, "输入不存在: " + input);
    }
    // 此工具依赖 music21 Python 环境；通过子进程调用
    const convertScript = `
import json, os, sys
input_path = ${JSON.stringify(input)}
to_fmt = ${JSON.stringify(to)}
transpose_key = ${JSON.stringify(transpose)}
out_dir = ${JSON.stringify(out_dir)} or os.path.join(os.path.dirname(os.path.abspath(input_path)), "_e1_out")
os.makedirs(out_dir, exist_ok=True)
base = os.path.splitext(os.path.basename(input_path))[0]
notes = []
cur = input_path
if transpose_key:
    import subprocess
    tp = os.path.join(${JSON.stringify(INTERNAL)}, "工具_移调.py")
    out_t = os.path.join(out_dir, base + "_transposed.musicxml")
    r = subprocess.run([sys.executable, tp, input_path, transpose_key, out_t], capture_output=True, text=True, timeout=300)
    if r.returncode != 0:
        print(json.dumps({"ok": False, "error": f"移调失败: {r.returncode}", "stderr": r.stderr[-300:]}))
        sys.exit(0)
    cur = out_t
    notes.append(f"移调 {transpose_key} 完成")
from music21 import converter
score = converter.parse(cur)
n_before = len(score.recurse().notes)
ext_map = {"musicxml": ".musicxml", "mxl": ".mxl", "midi": ".mid", "krn": ".krn"}
fmt_map = {"krn": "humdrum"}
ext = ext_map[to_fmt]
fmt = fmt_map.get(to_fmt, to_fmt)
out_path = os.path.join(out_dir, base + ext)
score.write(fmt, fp=out_path)
back = converter.parse(out_path)
n_after = len(back.recurse().notes)
print(json.dumps({"ok": True, "out_path": out_path, "note_count_before": n_before, "note_count_after": n_after, "conservation": n_before == n_after, "notes": notes}))
`;
    const r = await run([PY, "-c", convertScript], { timeout: 300_000 });
    if (!r.ok) {
      return three(false, {}, {}, {}, r.error || `转换退出码 ${r.code}`);
    }
    try {
      const j = JSON.parse(r.stdout.trim().split("\n").pop() || "{}");
      if (!j.ok) return three(false, {}, {}, {}, j.error);
      return three(
        true,
        { out_path: j.out_path, note_count_before: j.note_count_before, note_count_after: j.note_count_after },
        { notes: j.notes, conservation: j.conservation },
        { transposed: Boolean(transpose) },
      );
    } catch {
      return three(false, {}, {}, {}, "转换输出不可解析");
    }
  },
);

// ── 工具 6: render_score ────────────────────────────────────

server.registerTool(
  "render_score",
  {
    description:
      "渲染出图／PDF：MusicXML → verovio → 每页 SVG／PNG／PDF（A4 或贴合内容）。",
    inputSchema: z.object({
      input: z.string().describe("musicxml 本地路径"),
      out_dir: z.string().default("").describe("产物目录（可选）"),
      a4: z.boolean().default(true).describe("A4 版式（否则贴合内容）"),
      formats: z.array(z.enum(["svg", "png", "pdf"])).default(["pdf", "png"]).describe("输出格式列表"),
    }),
  },
  async ({ input, out_dir, a4, formats }) => {
    if (!existsSync(input)) {
      return three(false, {}, {}, {}, "输入不存在: " + input);
    }
    const out = ensureOutDir(input, out_dir || undefined);
    const base = path.basename(input, path.extname(input));
    const outbase = path.join(out, base);
    const cmd = [PY, path.join(TOOLS, "vv_render.py")];
    if (a4) cmd.push("--a4");
    cmd.push(input, outbase);
    const r = await run(cmd, { timeout: 600_000 });
    if (!r.ok) {
      return three(false, {}, {}, {}, r.error || `渲染退出码 ${r.code}`);
    }
    // 收集产物文件
    const { readdirSync } = await import("node:fs");
    let files: string[] = [];
    try {
      const all = readdirSync(out);
      files = all
        .filter((f) => {
          const ext = path.extname(f).slice(1);
          return formats.includes(ext as "svg" | "png" | "pdf") && f.startsWith(base);
        })
        .map((f) => path.join(out, f));
    } catch { /* ignore */ }
    // 统计页数
    const svgFiles = files.filter((f) => f.endsWith(".svg"));
    const pages = new Set(svgFiles.map((f) => f.split("_p").pop()?.split(".")[0])).size;
    return three(
      true,
      { files, page_count: pages || "?" },
      {},
      { elapsed_sec: r.elapsedSec },
    );
  },
);

// ── 启动 ────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("xiange-mcp server v0.1.0 running on stdio");
}

main().catch((err) => {
  console.error("xiange-mcp fatal:", err);
  process.exit(1);
});