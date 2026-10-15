# 召回基线

把「记忆好不好」变成能对照的数字。设计取舍见 `electron/services/knowledge/SPEC.md` 的
「记忆召回要有一条能对照的基线」。

## 跑一次

```bash
npm run sailfish -- knowledge bench                      # 用仓库自带的中性语料
npm run sailfish -- knowledge bench --set <问题集.json>    # 用自己的语料
npm run sailfish -- knowledge bench --save <报告.json>     # 存档，留着日后对照
npm run sailfish -- knowledge bench:compare <旧报告> <新报告>
```

基线只读，不改任何召回参数。跑完会把自己入库的语料清掉（`--keep` 可保留）；
语料如果本来就在库里，原样复用，也不会被清理动到。

## 怎么读

- **主动检索**：Agent 自己调搜索时的命中率。
- **自动到场**：每轮对话自动注入上下文那条路的命中率，门槛高得多，也是用户真正感知到的「它记不记得」。
- **噪音**：一组与语料明确无关的问题，期望零召回。
- **平均篇幅**：自动到场每轮注入多少字，代表上下文预算占用。

**四项要一起看。** 只盯命中率，最省事的改法就是把门槛调低——命中率一定涨，代价是
无关内容开始挤进每一轮对话，而那个代价只在噪音率和篇幅里看得见。该来的更多、
不该来的没变多、篇幅没失控，才算改好了。

## 出题

```bash
npm run sailfish -- knowledge bench:gen <文件或目录...> --out <问题集.json> --per-doc 8
```

AI 读完文档出候选，**采纳与否由人定**：把要用的那条 `status` 改成 `approved`，
不要的改成 `rejected`。评测默认只跑已采纳的；想先看看效果加 `--include-candidates`。

出题会被模型侧的输出长度掐断，所以是分小批问的。仍然失败就减小 `--per-doc`、
用 `--profile` 换个模型，或者照 `repo-docs.question-set.json` 的格式手写。

## 语料放哪

真实语料（监管文件等）可能涉密，**问题集里只记路径，文件本身不进仓库**；相对路径按
问题集所在目录解析。仓库自带的 `repo-docs.question-set.json` 用的是本仓库 `docs/` 下的
三份文档，换台机器、没有用户数据也能跑，回归用的就是它。

## 存档

`baseline-2026-10-15.json` 是本仓库语料的第一条基线，开发机、本地轻量嵌入模型下跑出。

换嵌入模型、换语料、换问题数之后分数都不可直接比，`bench:compare` 会直接把这种情况
标出来。所以要对照的话，拿同一份问题集在同一台机器上跑前后两次。
