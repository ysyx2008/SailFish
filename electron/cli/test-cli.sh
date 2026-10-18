#!/usr/bin/env bash
# =============================================================================
# SailFish CLI 功能验证测试
#
# 目标：每次后端代码修改后运行，验证各服务的业务逻辑正确性。
# 不只是"不崩溃"，而是验证输出内容符合预期。
#
# 用法:
#   bash electron/cli/test-cli.sh              # 完整测试（含 AI，需 API Key）
#   bash electron/cli/test-cli.sh --no-ai      # 跳过需要 AI API 的测试
#   bash electron/cli/test-cli.sh --quick       # 最小冒烟测试
#
# 环境变量:
#   SFT_API_URL / SFT_API_KEY / SFT_MODEL  — AI 测试所需（也可用桌面借用的 Profiles）
#   SFT_DATA_DIR                           — 未设时强制临时目录沙箱（不污染桌面；仍会借用 Key/Profiles）
#   SFT_CLI_NO_BORROW=1                    — 禁止从桌面借用
# =============================================================================
set -uo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CLI="node ${PROJECT_ROOT}/electron/cli/main.js"

# 退出时（含中途 Ctrl-C）清掉登记过的临时目录
TMP_DIRS=()
cleanup_tmp_dirs() {
  for dir in ${TMP_DIRS[@]+"${TMP_DIRS[@]}"}; do rm -rf "$dir"; done
}
trap cleanup_tmp_dirs EXIT

# 回归测试强制沙箱：忽略外部环境里的 SFT_DATA_DIR，避免误写桌面
# 需要复现某份数据时：SFT_TEST_ALLOW_SHARED_DATA=1 bash test-cli.sh
if [[ "${SFT_TEST_ALLOW_SHARED_DATA:-}" != "1" ]]; then
  SFT_DATA_DIR="$(mktemp -d "${TMPDIR:-/tmp}/sft-cli-test-XXXXXX")"
  export SFT_DATA_DIR
  TMP_DIRS+=("$SFT_DATA_DIR")
fi

PASS=0
FAIL=0
SKIP=0
TOTAL=0
FAILED_CMDS=()

MODE="full"
[[ "${1:-}" == "--quick" ]] && MODE="quick"
[[ "${1:-}" == "--no-ai" ]] && MODE="no-ai"

HAS_AI=false
[[ -n "${SFT_API_KEY:-}" ]] && HAS_AI=true
# 无环境变量时：启动一次 CLI，看能否从桌面借用到 AI Profiles
if [[ "$HAS_AI" != "true" && "$MODE" != "no-ai" ]]; then
  if $CLI ai:models 2>/dev/null | grep -qE 'https?://'; then
    HAS_AI=true
  fi
fi

# 颜色
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

# ── 测试工具函数 ──────────────────────────────────────────────

# 基础测试：命令成功退出
run_test() {
  local label="$1"; shift
  ((TOTAL++))
  printf "  %-40s " "${label}"

  local output exit_code=0
  output=$("$@" 2>&1) || exit_code=$?

  if [[ $exit_code -eq 0 ]]; then
    echo -e "${GREEN}PASS${NC}"
    ((PASS++))
  else
    echo -e "${RED}FAIL${NC} (exit $exit_code)"
    FAILED_CMDS+=("${label}")
    ((FAIL++))
    [[ -n "$output" ]] && echo "    └─ ${output:0:300}"
  fi
  # 把输出存到 _LAST_OUTPUT 供后续断言使用
  _LAST_OUTPUT="$output"
}

# 断言测试：命令成功且输出包含指定文本
assert_contains() {
  local label="$1"; shift
  local expected="$1"; shift
  ((TOTAL++))
  printf "  %-40s " "${label}"

  local output exit_code=0
  output=$("$@" 2>&1) || exit_code=$?

  if [[ $exit_code -ne 0 ]]; then
    echo -e "${RED}FAIL${NC} (exit $exit_code)"
    FAILED_CMDS+=("${label}: 非零退出")
    ((FAIL++))
    [[ -n "$output" ]] && echo "    └─ ${output:0:300}"
  # 用 [[ ]] 子串匹配，避免 pipefail + grep -q 早退时 echo 收到 SIGPIPE（exit 141）
  # 误判失败（知识库 list 等大输出场景会稳定复现）
  elif [[ -z "$expected" || "$output" == *"$expected"* ]]; then
    echo -e "${GREEN}PASS${NC}"
    ((PASS++))
  else
    echo -e "${RED}FAIL${NC} (输出不含 \"$expected\")"
    FAILED_CMDS+=("${label}: 缺少预期内容 '${expected}'")
    ((FAIL++))
    echo "    └─ 实际输出: ${output:0:300}"
  fi
  _LAST_OUTPUT="$output"
}

# 对上一条命令的输出再看一眼，避免同一条重跑
assert_last_contains() {
  local label="$1" expected="$2"
  ((TOTAL++))
  printf "  %-40s " "${label}"
  if [[ "${_LAST_OUTPUT:-}" == *"$expected"* ]]; then
    echo -e "${GREEN}PASS${NC}"
    ((PASS++))
  else
    echo -e "${RED}FAIL${NC} (输出不含 \"$expected\")"
    FAILED_CMDS+=("${label}: 缺少预期内容 '${expected}'")
    ((FAIL++))
  fi
}

assert_last_excludes() {
  local label="$1" expected="$2"
  ((TOTAL++))
  printf "  %-40s " "${label}"
  if [[ "${_LAST_OUTPUT:-}" == *"$expected"* ]]; then
    echo -e "${RED}FAIL${NC} (输出不该含 \"$expected\")"
    FAILED_CMDS+=("${label}: 含了不该有的 '${expected}'")
    ((FAIL++))
  else
    echo -e "${GREEN}PASS${NC}"
    ((PASS++))
  fi
}

# 断言测试：命令应失败（非零退出）
assert_fails() {
  local label="$1"; shift
  ((TOTAL++))
  printf "  %-40s " "${label}"

  local output exit_code=0
  output=$("$@" 2>&1) || exit_code=$?

  if [[ $exit_code -ne 0 ]]; then
    echo -e "${GREEN}PASS${NC} (预期失败, exit $exit_code)"
    ((PASS++))
  else
    echo -e "${RED}FAIL${NC} (应该失败但成功了)"
    FAILED_CMDS+=("${label}: 应失败但返回 0")
    ((FAIL++))
  fi
  _LAST_OUTPUT="$output"
}

skip_test() {
  local label="$1"; local reason="${2:-quick mode}"
  ((TOTAL++))
  printf "  %-40s " "${label}"
  echo -e "${YELLOW}SKIP${NC} (${reason})"
  ((SKIP++))
}

# ── 开始测试 ─────────────────────────────────────────────────

echo ""
echo -e "${CYAN}${BOLD}╔══════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}${BOLD}║       SailFish CLI 功能验证测试               ║${NC}"
echo -e "${CYAN}${BOLD}╚══════════════════════════════════════════════╝${NC}"
echo -e "  模式: ${BOLD}${MODE}${NC}    AI API: ${HAS_AI}"
echo ""

# ══════════════════════════════════════════════════════════════
echo -e "${CYAN}[1/12] 基础命令${NC}"
# ══════════════════════════════════════════════════════════════

assert_contains "--help 显示帮助信息"        "用法:" \
  $CLI --help

assert_contains "--help 含联络命令"          "companion" \
  $CLI --help

assert_fails    "companion 缺少消息应报错"   \
  $CLI companion

assert_contains "--version 返回版本号"       "." \
  $CLI --version

assert_fails    "未知命令应报错"             \
  $CLI this:does:not:exist

# ══════════════════════════════════════════════════════════════
echo ""
echo -e "${CYAN}[2/12] 配置读写闭环${NC}"
# ══════════════════════════════════════════════════════════════

# 读取当前语言
assert_contains "config:get language"        "zh" \
  $CLI config:get language

# 写入→读回→还原 闭环测试
# stdout 可能混有启动日志，只取最后一行 JSON 值
ORIG_THEME=$($CLI config:get theme 2>/dev/null | tail -1 | tr -d '"')
if [[ -z "$ORIG_THEME" ]]; then
  echo -e "  ${YELLOW}跳过 theme 闭环（无法读取原始 theme）${NC}"
  ((SKIP++))
else
  assert_contains "config:set theme 写入"      "" \
    $CLI config:set theme '"solarized"'

  assert_contains "config:get theme 验证写入"   "solarized" \
    $CLI config:get theme

  # 还原
  $CLI config:set theme "\"${ORIG_THEME}\"" >/dev/null 2>&1

  assert_contains "config:get theme 验证还原"   "${ORIG_THEME}" \
    $CLI config:get theme
fi

assert_contains "config:list 列出所有配置"    "language" \
  $CLI config:list

assert_contains "config:init 显示引导"        "AI" \
  $CLI config:init

# 错误场景
assert_fails    "config:get 缺少参数应报错"  \
  $CLI config:get

# ══════════════════════════════════════════════════════════════
echo ""
echo -e "${CYAN}[3/12] 主机画像${NC}"
# ══════════════════════════════════════════════════════════════

assert_contains "host:list 包含 local"       "local" \
  $CLI host:list

assert_contains "host:get local 有 OS 信息"  "os" \
  $CLI host:get local

assert_fails    "host:get 缺少参数应报错"    \
  $CLI host:get

# ══════════════════════════════════════════════════════════════
echo ""
echo -e "${CYAN}[4/12] SSH 会话${NC}"
# ══════════════════════════════════════════════════════════════

run_test "ssh:list 不崩溃"                   $CLI ssh:list

# ══════════════════════════════════════════════════════════════
echo ""
echo -e "${CYAN}[5/12] 知识库全流程${NC}"
# ══════════════════════════════════════════════════════════════

assert_contains "knowledge:stats 返回 JSON"   "documentCount" \
  $CLI knowledge:stats

assert_contains "knowledge:folder:create 空目录留下来" "公司制度/差旅" \
  $CLI knowledge:folder:create "公司制度/差旅"
assert_contains "knowledge:folder:list 看得到空目录" "公司制度/差旅" \
  $CLI knowledge:folder:list
assert_contains "秘书列目录：看得见空的下级目录" "公司制度/差旅/（还没有文件）" \
  $CLI knowledge:catalog "公司制度"
assert_contains "秘书列根：根上有下级目录" "公司制度/（还没有文件）" \
  $CLI knowledge:catalog
assert_contains "秘书选列全部目录：所有层级都在" "公司制度/差旅/（还没有文件）" \
  $CLI knowledge:catalog --all-folders
assert_fails "秘书选列全部目录，目录不存在也报错" \
  $CLI knowledge:catalog "不存在的目录" --all-folders
assert_fails "秘书列不存在的目录要报错，不当成空目录" \
  $CLI knowledge:catalog "不存在的目录"
assert_contains "knowledge:folder:rename 下级跟着走" "规章/差旅" \
  $CLI knowledge:folder:rename "公司制度" "规章"
assert_contains "knowledge:folder:delete 删掉空目录" "已删除目录" \
  $CLI knowledge:folder:delete "规章"
assert_contains "删掉之后目录不再出现" "（没有目录）" \
  $CLI knowledge:folder:list
assert_fails "knowledge:folder:create 拒绝往上跳" \
  $CLI knowledge:folder:create "../秘密"

assert_contains "说明额度一天二十份" "accepted=20" \
  $CLI knowledge:card:quota --drain
assert_contains "说明额度用尽不再加" "accepted=0" \
  $CLI knowledge:card:quota --drain

# 添加文档→搜索命中→验证
if [[ "$MODE" != "quick" ]]; then
  # 创建测试文档（macOS 的 mktemp 不替换后缀前的 X，放进随机目录里免得和上次残留撞名）
  TEST_DOC_DIR=$(mktemp -d "${TMPDIR:-/tmp}/sft-test-doc-XXXXXX")
  TMP_DIRS+=("$TEST_DOC_DIR")
  TEST_DOC="$TEST_DOC_DIR/kubernetes.md"
  echo "这是一份关于 Kubernetes 容器编排部署的技术文档，用于 SailFish CLI 自动化测试。" > "$TEST_DOC"

  run_test "knowledge:add 添加测试文档"      $CLI knowledge:add "$TEST_DOC"

  # add 之后再 list，确保有文档可列（空库时 list 输出为空会误判）
  assert_contains "knowledge:list 返回表格"     "id" \
    $CLI knowledge:list

  FOLDER_DOC="$TEST_DOC_DIR/leave.md"
  echo "差旅报销超过一千元需要部门负责人审批，附票据后五个工作日内办结。" > "$FOLDER_DOC"
  assert_contains "knowledge:add 放进目录"       "公司制度/差旅" \
    $CLI knowledge:add "$FOLDER_DOC" --folder "公司制度/差旅"
  assert_contains "knowledge:list 显示目录"      "公司制度/差旅" \
    $CLI knowledge:list

  node -e '
    const fs = require("fs")
    const file = process.argv[1]
    const raw = JSON.parse(fs.readFileSync(file, "utf8"))
    const doc = (raw.documents || []).find(d => d.filename === "leave.md")
    if (!doc) process.exit(1)
    delete doc.folder
    delete doc.addedBy
    delete doc.cardStatus
    fs.writeFileSync(file, JSON.stringify(raw, null, 2))
  ' "$SFT_DATA_DIR/knowledge/documents.json"
  $CLI knowledge:list >/dev/null
  run_test "老档案缺字段会补上" node -e '
    const fs = require("fs")
    const raw = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
    const doc = (raw.documents || []).find(d => d.filename === "leave.md")
    if (!doc || doc.addedBy !== "user" || doc.cardStatus !== "pending" || doc.folder !== "") {
      console.error(doc)
      process.exit(1)
    }
  ' "$SFT_DATA_DIR/knowledge/documents.json"

  LEAVE_ID=$(node -e '
    const fs = require("fs")
    const raw = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
    const doc = (raw.documents || []).find(d => d.filename === "leave.md")
    if (!doc) process.exit(1)
    process.stdout.write(doc.id)
  ' "$SFT_DATA_DIR/knowledge/documents.json")
  assert_fails "删除用户放入的要先确认" \
    $CLI knowledge:remove "$LEAVE_ID"
  node -e '
    const fs = require("fs")
    const file = process.argv[1]
    const raw = JSON.parse(fs.readFileSync(file, "utf8"))
    const doc = (raw.documents || []).find(d => d.filename === "leave.md")
    if (!doc) process.exit(1)
    doc.addedBy = "agent"
    fs.writeFileSync(file, JSON.stringify(raw, null, 2))
  ' "$SFT_DATA_DIR/knowledge/documents.json"
  assert_contains "自己放入的可以直接删" "已删除" \
    $CLI knowledge:remove "$LEAVE_ID"
  run_test "删掉之后检索条目也没了" node -e '
    const fs = require("fs")
    const raw = fs.readFileSync(process.argv[1], "utf8")
    if (raw.includes(process.argv[2])) process.exit(1)
  ' "$SFT_DATA_DIR/knowledge/bm25-index.json" "$LEAVE_ID"
  run_test "删掉之后向量也没了" node --input-type=module -e '
    import * as lancedb from "@lancedb/lancedb"
    const q = String.fromCharCode(39)
    const db = await lancedb.connect(process.argv[1])
    const names = await db.tableNames()
    if (!names.includes("knowledge_vectors")) process.exit(1)
    const table = await db.openTable("knowledge_vectors")
    const where = "`docId` = " + q + process.argv[2] + q
    const rows = await table.query().where(where).limit(5).toArray()
    if (rows.length !== 0) process.exit(1)
  ' "$SFT_DATA_DIR/knowledge/lancedb" "$LEAVE_ID"

  # 用语义相关的词搜索，验证向量检索能力
  assert_contains "knowledge:search 语义搜索" "Kubernetes" \
    $CLI knowledge:search "容器编排"

  K8S_ID=$(node -e '
    const fs = require("fs")
    const raw = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
    const doc = (raw.documents || []).find(d => d.filename === "kubernetes.md")
    if (!doc) process.exit(1)
    process.stdout.write(doc.id)
  ' "$SFT_DATA_DIR/knowledge/documents.json")

  assert_contains "没写说明时文件名也能到场" "kubernetes.md" \
    $CLI knowledge:context "这是一份关于 Kubernetes 容器编排部署的技术文档"
  assert_last_contains "没写说明时也按目录印象到场" "按相关度从档案室翻到的线索"
  assert_last_excludes "正文问法不带出无关目录" "公司制度"

  assert_contains "写上检索说明" "已写说明" \
    $CLI knowledge:card "$K8S_ID" --text "航海图：Kubernetes 容器编排"
  assert_contains "有说明时召回是目录印象" "按相关度从档案室翻到的线索" \
    $CLI knowledge:context "这是一份关于 Kubernetes 容器编排部署的技术文档"
  assert_last_contains "目录印象带上那行说明" "航海图：Kubernetes 容器编排"

  echo '{' > "$SFT_DATA_DIR/knowledge/card-vectors.json"
  assert_contains "说明向量坏了文件名还在" "kubernetes.md" \
    $CLI knowledge:context "这是一份关于 Kubernetes 容器编排部署的技术文档"
  assert_last_contains "说明向量坏了仍是目录印象" "按相关度从档案室翻到的线索"

  node --input-type=module -e '
    import * as lancedb from "@lancedb/lancedb"
    const db = await lancedb.connect(process.argv[1])
    const names = await db.tableNames()
    if (names.includes("knowledge_names")) await db.dropTable("knowledge_names")
    await db.createTable("knowledge_names", [{ id: "broken", note: "not-a-vector" }])
  ' "$SFT_DATA_DIR/knowledge/lancedb"
  assert_contains "目录索引也坏了仍能召回正文" "kubernetes.md" \
    $CLI knowledge:context "这是一份关于 Kubernetes 容器编排部署的技术文档"
  assert_last_excludes "目录索引也坏了退回正文片段" "按相关度从档案室翻到的线索"
  node --input-type=module -e '
    import * as lancedb from "@lancedb/lancedb"
    const db = await lancedb.connect(process.argv[1])
    const names = await db.tableNames()
    if (names.includes("knowledge_names")) await db.dropTable("knowledge_names")
  ' "$SFT_DATA_DIR/knowledge/lancedb"

  TITLE_DOC="$TEST_DOC_DIR/差旅报销.md"
  MENU_DOC="$TEST_DOC_DIR/菜单.md"
  echo "今天天气晴朗适合散步。" > "$TITLE_DOC"
  echo "食堂每周一换菜。" > "$MENU_DOC"
  assert_contains "按标题放入差旅" "公司制度/差旅" \
    $CLI knowledge:add "$TITLE_DOC" --folder "公司制度/差旅"
  run_test "旁边放一份无关文件" \
    $CLI knowledge:add "$MENU_DOC" --folder "公司制度/差旅"
  assert_contains "按文件名召回，不靠正文" "差旅报销.md" \
    $CLI knowledge:context "公司制度里的差旅报销"
  assert_last_contains "对上的目录只带目录本身" "目录：公司制度/差旅"
  assert_last_excludes "目录对上也不倒出旁边的文件" "菜单.md"
  assert_last_excludes "文件名对上的不带出无关正文" "天气晴朗"

  # 二进制格式必须走解析器。用例一直只用 .md，所以「PDF 入库成字节流还报成功」长期没被发现
  assert_contains "knowledge:add PDF 走解析器"  "type: pdf" \
    $CLI knowledge:add "${PROJECT_ROOT}/electron/cli/__tests__/fixtures/sample.pdf"

  assert_contains "PDF 正文确实入库"            "sample.pdf" \
    $CLI knowledge:search "Photosynthesis chloroplasts"

  # 召回基线：跑仓库自带的中性语料，顺带验证存档与对比
  assert_contains "knowledge bench 跑出基线"    "自动到场" \
    $CLI knowledge:bench

  BENCH_REPORT="$TEST_DOC_DIR/bench-report.json"
  run_test "knowledge bench --save 存档"        $CLI knowledge:bench --save "$BENCH_REPORT"

  assert_contains "knowledge bench:compare"     "读法" \
    $CLI knowledge:bench:compare "$BENCH_REPORT" "$BENCH_REPORT"

  # 库里留着孤儿（上次异常退出就会留）时，启动后的后台清理会和入库并发。
  # 曾经的 bug 是清理把刚入库文档的 chunk 一起删掉——列表里看得见，搜索永远搜不到
  ORPHAN_DOC="$TEST_DOC_DIR/orphan-guard.md"
  echo "海水稻在滨海盐碱地的育种试验记录，含耐盐碱品系的产量对比。" > "$ORPHAN_DOC"
  node -e '
    const fs = require("fs")
    const raw = JSON.parse(fs.readFileSync(process.argv[1], "utf-8"))
    const docs = Array.isArray(raw) ? raw : (raw.documents || [])
    const victim = docs.find(d => d.filename === "kubernetes.md")
    if (!victim) { console.error("找不到可摘的文档，孤儿场景没造出来"); process.exit(1) }
    const kept = docs.filter(d => d.id !== victim.id)
    fs.writeFileSync(process.argv[1], JSON.stringify(Array.isArray(raw) ? kept : { ...raw, documents: kept }, null, 2))
  ' "$SFT_DATA_DIR/knowledge/documents.json"

  run_test "孤儿残留时仍能入库"                $CLI knowledge:add "$ORPHAN_DOC"

  assert_contains "孤儿清理不误删新入库文档"    "orphan-guard.md" \
    $CLI knowledge:search "盐碱地 育种"

else
  skip_test "knowledge:add 添加文档"
  skip_test "knowledge:list 返回表格"
  skip_test "knowledge:add 放进目录"
  skip_test "knowledge:list 显示目录"
  skip_test "knowledge:search 命中验证"
  skip_test "没写说明时文件名也能到场"
  skip_test "没写说明时也按目录印象到场"
  skip_test "正文问法不带出无关目录"
  skip_test "写上检索说明"
  skip_test "有说明时召回是目录印象"
  skip_test "目录印象带上那行说明"
  skip_test "说明向量坏了文件名还在"
  skip_test "说明向量坏了仍是目录印象"
  skip_test "目录索引也坏了仍能召回正文"
  skip_test "目录索引也坏了退回正文片段"
  skip_test "按标题放入差旅"
  skip_test "旁边放一份无关文件"
  skip_test "按文件名召回，不靠正文"
  skip_test "对上的目录只带目录本身"
  skip_test "目录对上也不倒出旁边的文件"
  skip_test "文件名对上的不带出无关正文"
  skip_test "老档案缺字段会补上"
  skip_test "删除用户放入的要先确认"
  skip_test "自己放入的可以直接删"
  skip_test "删掉之后检索条目也没了"
  skip_test "删掉之后向量也没了"
  skip_test "knowledge:add PDF 走解析器"
  skip_test "knowledge bench 跑出基线"
  skip_test "孤儿残留时仍能入库"
  skip_test "孤儿清理不误删新入库文档"
fi

# 搜索不存在的内容
run_test "knowledge:search 无结果不崩溃"     $CLI knowledge:search "zzz_nonexistent_query_zzz"

# ══════════════════════════════════════════════════════════════
echo ""
echo -e "${CYAN}[6/12] 历史记录${NC}"
# ══════════════════════════════════════════════════════════════

run_test "history:list 不崩溃"               $CLI history:list
assert_contains "history:list --limit 2"     "steps" \
  $CLI history:list --limit 2
assert_contains "history:stats 返回 JSON"    "agentFiles" \
  $CLI history:stats

# ══════════════════════════════════════════════════════════════
echo ""
echo -e "${CYAN}[7/12] 定时任务 / MCP / 技能${NC}"
# ══════════════════════════════════════════════════════════════

run_test "scheduler:list 不崩溃"             $CLI scheduler:list
run_test "scheduler:history 不崩溃"          $CLI scheduler:history
run_test "mcp:list 不崩溃"                   $CLI mcp:list
run_test "skill:list 不崩溃"                 $CLI skill:list

# ══════════════════════════════════════════════════════════════
echo ""
echo -e "${CYAN}[8/12] Watch & Sensor（感知层）${NC}"
# ══════════════════════════════════════════════════════════════

run_test "watch:list 不崩溃"                 $CLI watch:list
run_test "watch:history 不崩溃"              $CLI watch:history
run_test "todo:list 不崩溃"                  $CLI todo:list
assert_contains "todo:create 创建待办"        "Todo created" \
  $CLI todo:create --title "cli-todo-test"
TODO_ID=$(echo "$_LAST_OUTPUT" | grep -oE '\([a-f0-9-]{8,}\)' | tr -d '()' | head -1)
if [[ -n "$TODO_ID" ]]; then
  run_test "todo:delete 删除待办"           $CLI todo:delete "$TODO_ID"
else
  skip_test "todo:delete 删除待办"
fi
run_test "sensor:status 不崩溃"              $CLI sensor:status
run_test "sensor:heartbeat 不崩溃"           $CLI sensor:heartbeat
run_test "bond:status 不崩溃"               $CLI bond:status

# watch:create + watch:delete 闭环
assert_contains "watch:create 创建 Watch"    "Watch created" \
  $CLI watch:create --name "test-watch" --prompt "test" --output log
# 从上次输出中提取 watch ID 并删除
WATCH_ID=$(echo "$_LAST_OUTPUT" | grep -oE '\([a-z0-9]+-[a-z0-9]+\)' | tr -d '()')
if [[ -n "$WATCH_ID" ]]; then
  run_test "watch:delete 删除 Watch"         $CLI watch:delete "$WATCH_ID"
else
  skip_test "watch:delete 删除 Watch"
fi

assert_fails "watch:create 缺少参数应报错"   $CLI watch:create

# Phase 2 & 3 新功能
run_test "watch:templates 列出模板"         $CLI watch:templates
assert_contains "watch:from-template 创建"  "Watch created" \
  $CLI watch:from-template morning-briefing
# 清理模板创建的 watch
TPL_WATCH_ID=$(echo "$_LAST_OUTPUT" | grep -oE 'ID: [a-z0-9]+-[a-z0-9]+' | sed 's/ID: //')
if [[ -n "$TPL_WATCH_ID" ]]; then
  run_test "清理模板 Watch"                 $CLI watch:delete "$TPL_WATCH_ID"
fi
assert_fails "watch:from-template 无效模板" $CLI watch:from-template nonexistent-tpl
# ══════════════════════════════════════════════════════════════
echo ""
echo -e "${CYAN}[9/12] PTY 命令执行${NC}"
# ══════════════════════════════════════════════════════════════

assert_contains "pty:shells 列出 shell"      "shell" \
  $CLI pty:shells

if [[ "$MODE" != "quick" ]]; then
  assert_contains "pty:exec echo 验证输出"    "hello_sft" \
    $CLI pty:exec "echo hello_sft"

  assert_contains "pty:exec pwd 返回路径"     "/" \
    $CLI pty:exec "pwd"
else
  skip_test "pty:exec echo 验证输出"
  skip_test "pty:exec pwd 返回路径"
fi

# ══════════════════════════════════════════════════════════════
echo ""
echo -e "${CYAN}[10/12] 文件系统 & 文档解析${NC}"
# ══════════════════════════════════════════════════════════════

assert_contains "fs:info 包含 Home 路径"      "Home" \
  $CLI fs:info

assert_contains "fs:list /tmp 返回表格"        "name" \
  $CLI fs:list /tmp

assert_fails    "fs:list 不存在路径应报错"     \
  $CLI fs:list /nonexistent_path_zzz

assert_contains "doc:types 列出 md 类型"       ".md" \
  $CLI doc:types

assert_contains "doc:parse 解析 README"        "SailFish" \
  $CLI doc:parse "${PROJECT_ROOT}/README.md"

assert_fails    "doc:parse 不存在文件应报错"   \
  $CLI doc:parse /nonexistent_file.txt

# ══════════════════════════════════════════════════════════════
echo ""
echo -e "${CYAN}[11/12] IM 集成${NC}"
# ══════════════════════════════════════════════════════════════

assert_contains "im:status 显示平台列表"       "DingTalk" \
  $CLI im:status

assert_contains "im:status 显示 Slack"         "Slack" \
  $CLI im:status

assert_fails    "im:connect 缺少参数应报错"    \
  $CLI im:connect

assert_fails    "im:connect 未知平台应报错"    \
  $CLI im:connect unknown_platform

# 未配置凭证时连接应失败
assert_fails    "im:connect 无凭证应报错"      \
  $CLI im:connect dingtalk

assert_fails    "im:disconnect 缺少参数应报错" \
  $CLI im:disconnect

# ══════════════════════════════════════════════════════════════
echo ""
echo -e "${CYAN}[12/12] AI 对话（需要 API Key）${NC}"
# ══════════════════════════════════════════════════════════════

if [[ "$MODE" == "quick" || "$MODE" == "no-ai" ]]; then
  skip_test "ai:models 列出模型"       "无 AI 配置或 --no-ai"
  skip_test "ai:chat 基础对话"         "无 AI 配置或 --no-ai"
  skip_test "ai:stream 流式对话"       "无 AI 配置或 --no-ai"
elif $HAS_AI; then
  run_test "ai:models 列出模型"                $CLI ai:models

  assert_contains "ai:chat 回复不为空"         "" \
    $CLI ai:chat "回复OK两个字母即可"

  run_test "ai:stream 流式不崩溃"              $CLI ai:stream "回复OK两个字母即可"
else
  skip_test "ai:models 列出模型"       "未设置 SFT_API_KEY"
  skip_test "ai:chat 基础对话"         "未设置 SFT_API_KEY"
  skip_test "ai:stream 流式对话"       "未设置 SFT_API_KEY"
fi

# ══════════════════════════════════════════════════════════════
# 汇总
# ══════════════════════════════════════════════════════════════
echo ""
echo -e "${CYAN}${BOLD}══════════════════════════════════════════════${NC}"
echo -e "  总计: ${BOLD}${TOTAL}${NC}    ${GREEN}通过: ${PASS}${NC}    ${RED}失败: ${FAIL}${NC}    ${YELLOW}跳过: ${SKIP}${NC}"
echo -e "${CYAN}${BOLD}══════════════════════════════════════════════${NC}"

if [[ ${#FAILED_CMDS[@]} -gt 0 ]]; then
  echo ""
  echo -e "${RED}${BOLD}失败项:${NC}"
  for cmd in "${FAILED_CMDS[@]}"; do
    echo -e "  ${RED}✗${NC} $cmd"
  done
  echo ""
  exit 1
fi

echo ""
echo -e "${GREEN}${BOLD}全部测试通过！${NC}"
exit 0
