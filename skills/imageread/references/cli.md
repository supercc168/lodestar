# CLI reference (`codex exec`)

`imageread.sh` 封装的就是 `codex exec`(codex-cli 0.144+)。这里记录完整 flag 与踩过的坑,供修改 wrapper 或裸调时参考。

## 核心 flag

- `-i, --image <FILE>...` 附加图片(可重复 `-i a -i b`)。**可变长,会贪婪吃后续位置参数**(见坑 1)。
- `-o, --output-last-message <FILE>` 把模型最终消息写入文件 —— 干净结果就靠它。
- `--json` 事件流(JSONL),需要逐事件处理时用。
- `-s, --sandbox <read-only|workspace-write|danger-full-access>` 沙箱策略。读图用 `read-only`。
- `--skip-git-repo-check` 不在 git 仓库也能跑(图片常在任意目录)。
- `--ephemeral` 不落 session 文件(读图是一次性,不 resume)。
- `-C, --cd <DIR>` 工作根(wrapper 默认 `/tmp`,避免扫描大工程)。
- `-c key=value` 覆盖 `~/.codex/config.toml`,如 `-c model_reasoning_effort=low`。
- `-m, --model <MODEL>` 覆盖模型(默认 config 的 `gpt-5.6-sol`)。
- `--output-schema <FILE>` 强制最终消息符合某 JSON Schema(需要结构化输出时用)。

## 已知坑(实测踩过)

1. **prompt 被 `-i` 吞掉**:`codex exec -i img "prompt"` 会把 prompt 当成第二个图片文件,然后报 `No prompt provided via stdin`。原因 `-i <FILE>...` 是可变长,贪婪消费后续位置参数。
   - 解决:prompt 走 **stdin**(`printf '%s' "$prompt" | codex exec ... -i img`),或把 prompt 放在 `-i` **之前**。wrapper 用 stdin,最稳。
2. **stdout 有过程噪音**:`reasoning effort` / `session id` / `tokens used` 等会打到 stdout。要干净文本必须用 `-o <file>` 读最终消息,**不要**解析 stdout。
3. **mac 无 GNU `timeout`**:`timeout` 命令不存在。用 perl 实现秒级超时:`perl -e 'alarm shift(@ARGV); exec @ARGV' <sec> codex ...`(alarm 跨 exec 仍生效,到点给进程发 SIGALRM)。
4. **默认 reasoning=max 很慢**:`~/.codex/config.toml` 设了 `model_reasoning_effort = "max"`。快速读图用 `-c model_reasoning_effort=low|medium` 覆盖。

## 推荐组合(裸调读图)

```bash
printf '%s' "$PROMPT" | perl -e 'alarm shift(@ARGV); exec @ARGV' 300 \
  codex exec -s read-only --skip-git-repo-check --ephemeral -C /tmp \
  -c model_reasoning_effort=medium \
  -o /tmp/out.txt \
  -i /abs/img1.png -i /abs/img2.png
```

退出码:codex 正常 0;perl 超时为 142(128+SIGALRM=14)。

## 配置来源

- 模型 / 供应商 / key:`~/.codex/config.toml`(当前 `model_provider = "custom"` → `api.wuhen-ai.com`,`model = "gpt-5.6-sol"`,有效窗口 353K(codex catalog 钳制,API 规格 1.05M),reasoning=max)。
- 认证:`~/.codex/auth.json`。
- 不需要在 shell 暴露任何 key;wrapper 也不读 key。

## 退出码约定(wrapper)

- `0` 成功,stdout 为最终分析文本。
- 非 0:codex 失败或超时;加 `--raw` 看 codex 原始输出排查。
