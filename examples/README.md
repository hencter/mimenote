# examples

两个能**直接用应用打开**的 Vault。都是普通文件夹里的普通 `.md`，没有构建步骤，
除了下面那一条完整性守卫之外也不参与 CI；删掉应用，里面的字一个不少。

| 目录 | 是什么 | 什么时候用它 |
| --- | --- | --- |
| `demo-vault/` | 演示库 | **手工验收 / 首次走查**。库内 `README.md` 就是那份验收清单（根 `README.md` 的「手工验收」一节指到这里），`Mimenote 软件介绍.md` 是从哪开始的导游 |
| `manual/` | 手册库（`manual` = 手册，不是"手动模式"） | 两份说明书：`用户说明书.md` 与 `开发者说明书.md`。用本软件自己的语法写成（frontmatter、`[[包内路径]]` 双链、标签），**同时是「整库导出静态站点」的验收样本** —— 导出它得到的形态就是网站 |

## 两件容易误会的事

**这里没有代码示例。** 本仓库的 `examples/` 指的是"能被应用打开的真实数据"；
Rust 那种示例程序在 `crates/mn-core/examples/`（如 `scan_bench.rs`）。

**权威文档不在这里。** `manual/` 是 `README.md`、`docs/architecture.md`、
`docs/milestones.md` 的**导游版**，口径停在 v0.3。命令表、门禁数字、发版流程这类
对外事实以 `docs/` 为准 —— 改权威文档时如果牵动了手册里的说法，顺手同步对应页。

`examples/` 本身**不是** Vault，两个子目录才是。

## 派生数据

应用打开任意一个库都会生成 `.mimenote/`（索引缓存、回收站）：可重建、不入库，
想回到干净状态直接删掉它。唯一的例外是 `demo-vault/.mimenote/snippets/example.css`
—— 它是内容（用户 CSS 片段），已入库。

## 唯一的自动守卫

`apps/desktop/tests/integration/demo-vault.test.ts` 钉住 `demo-vault/` 的结构与引用
（frontmatter 若出现就闭合、wikilink 目标都能解析、图片都在库内且文件真的存在），
以及文档承诺的那些演示内容还在。**`manual/` 目前没有守卫**，改它全靠自觉。
