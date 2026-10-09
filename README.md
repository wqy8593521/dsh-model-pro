# dsh-model-pro · 模型 Pro

[![npm version](https://img.shields.io/npm/v/dsh-model-pro.svg)](https://www.npmjs.com/package/dsh-model-pro)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

面向 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/dsh) 的动态 Cordis 插件，在设置页新增一个「**模型 Pro**」入口，为 `llm-pi-ai` 提供商提供**全生命周期管理 UI**：新建 / 编辑 / 删除、启用 / 禁用、拉取远端模型、连通性测试、智能路由、组合提供商、观测与探活——并在卸载时**保证模型数据零丢失**。

> 中文文档 · 界面内置中英双语（跟随 DSH 语言设置自动切换）。

---

## ✨ 功能特性（Features）

### 提供商管理
- **提供商 CRUD** — 新建（引导式 3 步向导）、编辑、删除，卡片式列表带状态色条（绿=启用 / 琥珀=禁用）。新建时会校验 `route` 是否与**已安装的内置提供商**重名并明确拒绝——否则同名档案会在 `llm-pi-ai` 里逐项覆盖内置端点，而原生模型页看起来一切正常，用户无从察觉。
- **启用 / 禁用** — 一键切换。被禁用的提供商会移出 `llm-pi-ai.providers`（因此从模型选择器中消失），完整档案寄存在本插件自有分区，配置一字不丢。
- **字段编辑** — 逐项编辑 `baseURL`、`api` 协议、`apiKeyEnv`、`displayName`（概览页附「就绪检查」清单）。编辑器为宽屏版式（最大 1200px）：头部与四个标签合成一张**吸顶卡片**，长 `route` 名自动折行；进入编辑器或切换标签会把设置页滚动复位，「返回列表」时恢复原来的列表位置；「模型」页的当前模型表格跟随整页滚动（无内部小滚动条），远端发现列表保持紧凑独立滚动。
- **自定义请求头** — 按提供商增删改 HTTP 请求头（`authorization` / `api-key` 由适配器自动填充，无需手填）。

### 密钥与凭据
- **加密存储** — 在 GUI 中直接粘贴 API Key，以 **AES-256-GCM 加密**写入配置（配置文件只存密文），同时写入 DSH 凭据服务供请求时解析。
- **按需解密查看** — 默认掩码显示，点「显示已存」可解密查看；加密主密钥存于凭据服务且**永不重新生成**，卸载重装后旧密文仍可解密。

### 模型
- **远端模型发现** — 一键 `GET /models` 拉取，支持全选 / 取消全选 / 反选。
- **批量写入模型** — 将选中模型「替换」或「合并」进提供商的显式模型列表。
- **本地转发名映射** — 为某个模型设置「转发名」，选它时实际向 provider 发送映射后的模型名。

### 连通性测试
- **真实连通性测试** —「测试」页对选定模型发起一次极小的真实推理，走完整凭据 / 请求头 / 协议链路，返回**延迟、停止原因与回复内容**，用来在依赖之前确认模型确实可用。

### 智能路由与组合
- **智能路由** — 命名路由（如 `auto`）聚合多个 provider 的模型，支持 **5 种策略**：`priority`（顺序优先+回退）/ `weighted`（按权重随机）/ `round-robin`（平滑加权轮询）/ `min-latency`（历史低延迟优先）/ `sticky`（会话粘滞）。可设每目标权重、启用开关、`healthAware`、会话粘滞、`maxFallbacks`、单目标超时。在模型选择器里选「router / 路由名」即用。
- **无感切换（真实回退）** — 首选目标**不可达时自动换下一个目标**：回退判定基于「首个内容块是否真正产出」，连接拒绝、HTTP 错误、空响应、超时（`timeoutMs`）都会在**任何内容到达对话之前**完成切换，对话无感知、不中断；调用方主动中止永不重试。回退成功的请求在观测台标记为 `fallback`。
- **组合提供商** — 把多个 provider 的模型合并成一个虚拟 provider，支持**并集 / 交集**两种模式（模型选择器中显示为 `composite / 组合名::模型`）；交集非常适合同款模型多上游互备。

### 观测与健康
- **探活（Probe）** — 对每个目标（`provider + model`）发起真实最小请求，标记 up / down / probing 与连续失败次数；健康感知分发会自动跳过 down 的目标（可按路由关闭）。
- **观测台** — 会话内请求日志（路由 → 目标、状态、**思考档位**、延迟、token）与聚合统计（按路由 / 按目标：调用次数、成功率、平均延迟、token 合计），以统计卡与表格呈现。
- **思考档位留痕** — 路由对外声明的是所有目标档位的**并集**，所以选 `max` 时若实际服务的目标只支持到 `high`，请求会**成功**但自动降档。观测台日志的「思考档位」列会标出 `max → high`（目标完全不支持时标 `max → 未下发`），对话徽章上同步显示 `max→high`，避免「选了高档位却拿到低档位答案」无从察觉。
- **对话提供商徽章（可开关）** — 开启后，每个回合完成时会在其下方显示智能路由 / 组合**实际选中并服务该回合**的目标（`provider/model`），发生自动切换时标注「已无感切换」；在「智能路由 → 观测台」用「对话下方显示实际提供商」开关控制，偏好持久化保存。

### 卸载安全（零数据丢失）
- **卸载不丢数据** — 当本插件被卸载或禁用时，会自动把自有分区里寄存的每个提供商**原样还原**回 `providers`，避免模型配置滞留在只有本插件认识的存储中。详见下文[工作原理](#-工作原理)。

---

## 📸 截图（Screenshots）

> 截图文件放在 [`docs/screenshots/`](docs/screenshots) 目录下。首次使用请自行截图后替换以下占位图。

| 页面 | 说明 |
|------|------|
| ![仪表盘](docs/screenshots/dashboard.png) | **仪表盘**：全部 / 已启用 / 已禁用分段（带计数）、引导式 3 步新建向导、状态色条卡片 |
| ![编辑器](docs/screenshots/editor.png) | **编辑器**：概览（字段 + 就绪检查）/ 请求头 / 模型 / 测试 四个标签页；头部+标签为吸顶卡片，模型表格跟随整页滚动 |
| ![模型发现](docs/screenshots/models.png) | **模型发现**：拉取远端模型，支持全选 / 反选与批量写入 |
| ![连通性测试](docs/screenshots/test.png) | **连通性测试**：对单个模型跑真实推理，显示延迟与回复 |
| ![智能路由](docs/screenshots/routes.png) | **智能路由**：路由台 / 组合提供商 / 观测台 / 探活 四个子页 |

---

## 📦 安装教程（Installation）

> DSH 的插件管理命令会转发给 `pnpm`，并要求用 `--profile <name>` 指定目标 Profile（Web GUI 通常是 `web`）。

### 方式一：从 npm 安装（推荐，预构建、无需构建脚本）

```sh
dsh plugin --profile web add npm:dsh-model-pro
```

> **务必带 `npm:` 前缀。** registry 上的包已预置 `dist/`，安装时不会触发构建脚本。
> 若省略前缀写成 `add dsh-model-pro`，pnpm 可能把它解析为 git 源，进而执行 `prepare`
> 构建脚本，被 pnpm 10 的安全策略拦截并报
> `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`。

### 方式二：从 GitHub 源安装（需允许构建脚本）

git 源不含预构建的 `dist/`，安装时靠 `prepare` 现场构建。pnpm 10 默认禁止 git 依赖
执行构建脚本，因此需先在 `~/.dsh/profiles/web/pnpm-workspace.yaml` 的 `allowBuilds`
下加入 `dsh-model-pro: true`，再执行：

```sh
dsh plugin --profile web add wqy8593521/dsh-model-pro
```

安装后重新打开（或刷新）DSH Web GUI，左侧「设置」中即出现「**模型 Pro**」入口。

### 方式三：从源码构建

```sh
git clone https://github.com/wqy8593521/dsh-model-pro.git
cd dsh-model-pro
npm install
npm run build       # 输出 dist/host.js + dist/client.js
npm test            # 运行冒烟测试（可选）
```

### 方式四：本地开发联调（软链安装，不发版）

在插件仓库根目录一键把**本工作区**软链进 Profile（等价于 `dsh plugin --profile web add link:<本目录>`，不拷贝、不触发 prepare 构建脚本，不受 pnpm 10 allowBuilds 限制）：

```sh
npm run install:local                  # 构建 + 软链安装到 ~/.dsh/profiles/web
npm run install:local -- --profile dev # 指定其他 Profile
npm run install:local -- --no-build    # dist 已是最新时跳过构建
```

之后的迭代循环：改代码 → `npm run build` → 重启 dsh / 刷新 Web GUI。回退 registry 版本：

```sh
dsh plugin --profile web remove dsh-model-pro && dsh plugin --profile web add npm:dsh-model-pro
```

> 本插件以**静态 bundle** 形态分发（Host 半为 ESM `apply` 导出，Client 半为
> `window.__ModuleLoader__.load` 工厂），必须通过 `dsh plugin add` 安装；
> 它不提供旧版动态插件（`cordis_define` / `cordis_run`）的加载形态。

---

## 🗑️ 卸载教程（Uninstall）

```sh
dsh plugin --profile web remove dsh-model-pro
```

**卸载是安全的**：插件在卸载 / 禁用时会执行 fiber 清理钩子，把自有分区里寄存的每个提供商（模型、请求头、凭据全部保留）还原回 `providers`。因此**不会有任何提供商或模型配置丢失**。加密 API Key 的主密钥存放在 DSH 凭据服务中、与插件解耦，卸载不会删除它——重装后旧密文仍可正常解密。

> 若只想临时停用而保留定义，用禁用而非卸载即可；两者都会触发同样的还原逻辑。

---

## 🚀 使用教程（Quick Start）

1. **新建提供商** — 进入「模型 Pro」，点右上角「新增提供商」，按 3 步向导填写：
   - **1 · 命名**：`route`（作为模型 ID 前缀，创建后不建议改）+ 可选显示名。
   - **2 · 连接**：选协议（OpenAI 兼容 / OpenAI Responses / Anthropic Messages）+ 填 `Base URL`。
   - **3 · 凭据**：填 API Key 环境变量名，或直接粘贴密钥（加密保存）。
   - 完成后可「创建并测试」或「创建并配置」。
2. **拉取模型** — 进入「模型」标签页，点「获取远端模型」，勾选需要的模型，选「替换为选中」或「合并选中」写入。
3. **连通性测试** — 「测试」标签页选一个模型，点「运行测试」，查看延迟、停止原因与真实回复，确认可用。
4. **智能路由**（可选）— 在「智能路由 → 路由台」新建命名路由，加入多个目标、选策略、设权重；在模型选择器里选「router / 路由名」使用，失败自动回退。
5. **组合提供商**（可选）— 「组合提供商」页选 2 个以上 provider，选并集 / 交集合并其能力；选择器里以「composite / 组合名::模型」使用。
6. **探活与观测**（可选）— 「探活」页对目标发起真实探测更新健康状态；「观测台」查看调用统计与请求日志。

---

## 🔍 工作原理

### 禁用 & 卸载还原
禁用会把提供商档案从 `llm-pi-ai.providers` 移入**本插件自有分区**（`dsh-model-pro`，由 `Config` 声明）。`llm-pi-ai` 适配器只解析 `providers`，所以被禁用的提供商会从模型选择器中消失——这是"禁用"真正生效的机制。

Host 半在 fiber 清理时（插件被卸载**或**禁用）执行逆运算：把每个被禁用的提供商连同完整档案还原回 `providers`。启用中的提供商不受影响。因此**不会有任何提供商或模型配置丢失**。

> **为什么不再用 `llm-pi-ai.disabledProviders`？**
> 早期版本把禁用状态寄存在 `llm-pi-ai` 这个**别的插件**的 section 里，作为 schema 未声明的外部键。这在 DSH 0.1.x 上能工作（校验宽松），但在 0.2.x 上是结构性不可用的：
>
> - 写入被拒 —— 0.2 逐键校验目标 section 的每个键是否落在 schema 的 `volatile()` 之下，未声明的键直接抛 `Config field "X" is not volatile` 并**拒绝整次写入**；
> - 读取不可见 —— `describe()` 会把 section 投影成 schema 已声明的字段，外部键连读都读不到。
>
> 更糟的是它会**连带打断 DSH 的配置迁移**：老的 `settings.yaml` 改名成 `.imported` 后逐 section 导入，`llm-pi-ai` 里只要残留这个外部键，整个 section 的导入就会被放弃（只留一条 warning），表现为"升级后模型全没了"。
>
> 现在改用插件自有分区：`llm-pi-ai` 只承载 `providers`，其余状态全部归位。旧版本遗留在 `llm-pi-ai` 里的键会在启动时自动搬入自有分区。

### DSH 版本兼容（0.1.x / 0.2.x）
所有设置读写都经过单一兼容层 [`src/host/compat.ts`](src/host/compat.ts)，该文件是唯一允许调用 settings 服务的模块（由 `tests/host.architecture.mjs` 机械保证，其他文件直接调用即测试失败）。它遵循四条规则：

1. **按能力探测，不按版本号** —— 用 `get(ns)` 与 `describe()` 两个独立能力判定服务形态：
   | 形态 | 特征 | 来源 |
   |------|------|------|
   | `raw` | `get(ns)` 返回原始 section；`replace()` 接受任意键 | DSH 0.1.x |
   | `descriptor` | 无 `get`；`describe()` 返回投影后的 section；写入受 `meta.volatile` 约束 | DSH 0.2.x |
   | `unknown` | 两者都没有 | 比本插件更新的 DSH |
2. **每个命名空间只有一条写路径** —— `writeLLMProviders`（只写 `providers`）与 `writeOwnedSection`（本插件自有状态）。自有分区的**部分写入**一律走读-合并-写（`writeOwnedState`）：在 0.2 上写入单个键，同 section 里没提到的 owned 键不会被重置。
3. **读不到的东西绝不销毁** —— `descriptor` 会投影掉未声明的键，因此旧数据迁移只搬它能看见的部分，其余原样留在原处。
4. **明确失败，绝不静默降级** —— 启动时执行 `selfCheck()`：往自有分区写入声明过的探针字段再读回，真实证明"读得到、写得住"。不通过会记录一条可诊断的告警，而不是让用户面对一个空列表。`unknown` 形态会明确报告，不会被猜测为 0.2。自检写入本身也遵守上面第 2 条：优先走宿主 `update()`（patch 层合并），没有 `update()` 的旧宿主退化为「先读出整段、合并后再 replace」。

> **部分写入与默认值（0.2 语义，2.0.2 起）**
> 0.2 的 `replace()` 语义是「先重置全部 live 字段，再写入给定字段」——直接传一个部分 section 会把同 section 里没提到的 owned 键清掉，`routes` / `composites` / `uiPrefs` 等状态因此曾在每次提供商写操作和每次启动时被静默重置。所以本插件对自有分区的所有写操作都经过读-合并-写。同样，`descriptor` 形态的读取优先取 `user`（patch）层而不是解析后的值：schemastery 的默认值不会被当作「用户写的」回写进文档，配置文件保持你写下的原样；由组合层定义的内置提供商不会被改写或展示，其路由照常解析。

**实测覆盖**：DSH `0.1.7-rc.2`、`0.2.0-rc.2`、`0.2.1-alpha.1` 上均启动并完成自检读写往返。CI 测试矩阵见 `tests/host.matrix.mjs` 与 `tests/host.compat-layer.mjs`。

> `0.1.x` 仍在支持中，但该兼容路径计划在 **v3** 移除；插件在 0.1 运行时启动时会记录一条弃用提示。

### 密钥加密
提供商 API Key 存于两处：**权威副本**在 DSH `credentials` 服务（`llm-pi-ai` 请求时解析）；**静态快照**为 `profile.apiKeyEnc` 下的 AES-256-GCM 密文。随机 AES 主密钥仅生成一次并存入凭据服务，**永不重新生成**，保证重装后旧密文仍可解密。沙箱缺少 WebCrypto 时回退到打包的纯 JS `@noble/ciphers`。

### 连通性测试
「测试」调用 `test-provider` handler：经 `llm.listModels` 解析一个已发布模型，`llm.prepareCall` 用提供商存储的凭据 / 请求头 / 协议准备调用，流式跑一次极小补全，返回延迟、停止原因与回复。默认 30 秒超时；禁用或未配置的提供商会在任何 I/O 前带指引拒绝。

### 跨 realm 安全
Host 半用 `makeHostPlain()` 以 `Object.create(null)`（无原型）递归重建对象，确保跨 vm 沙箱 realm 边界通过 `dsh-settings` 的 `isPlainObject` 校验。

### 构建系统
TypeScript 源码经 [esbuild](https://esbuild.github.io/)（`scripts/build.mjs`）产出两个静态 bundle：
`dist/host.js` 为 **ESM**（导出 `apply` / `name` / `inject`，DSH 加载器直接 `import`），框架
包（`@deepseek-ai/*`）保持 external、由 Profile 运行时解析；`dist/client.js` 为包在
`window.__ModuleLoader__.load({ id, factory })` 工厂里的 **CJS**，`react` 由 DSH 客户端
模块系统提供。Host↔Client RPC 走 **Typert Remote 服务**（契约见 `src/shared/contract.ts`）。

| 文件 | 说明 |
|------|------|
| `dist/host.js` | Host 侧包：`modelPro` Typert Remote 服务 + 路由/组合/健康/观测 |
| `dist/client.js` | Client 侧包：设置页 UI（`__ModuleLoader__` 工厂） |
| `cordis.patch.yml` | `dsh plugin add` 使用的 Cordis 组合补丁 |
| `package.json` | 含 `dsh.bundle` 清单的 npm 包元数据 |

---

## 🗂️ 项目结构

```
src/
├── shared/
│   ├── constants.ts          # NS、PROTOS、EDITABLE_FIELDS、路由/组合/观测键
│   ├── types.ts              # 共享 TypeScript 接口
│   ├── contract.ts           # Typert 契约：INVOCATIONS + TYPERT_MANIFEST（23 方法）
│   └── externals.d.ts        # 框架 peer 包的 ambient 类型（tsc 用）
├── host/
│   ├── index.ts              # apply(ctx) — Typert 注册 + 路由/组合/健康/观测装配
│   ├── service.ts            # ModelProRuntime extends TypertRemoteService
│   ├── compat.ts             # 兼容层：按能力判定 settings 形态 + 自检 + 两个命名空间写入
│   ├── settings.ts           # 自有分区读写、禁用停车位、旧数据迁移
│   ├── config.ts             # 自有分区 schema（Config）与自有 section 访问器
│   ├── utils.ts              # makeHostPlain 与基于兼容层的读写外观
│   ├── crypto.ts             # AES-256-GCM 密钥加解密（凭据服务主密钥）
│   ├── lifecycle.ts          # fiber 清理钩子 — 卸载时还原禁用提供商
│   ├── router.ts             # 智能路由分发引擎（router / composite 适配器）
│   ├── composite.ts          # 组合提供商（并集 / 交集）解析
│   ├── health.ts             # 目标健康追踪（探活）
│   ├── statsStore.ts         # 会话内请求日志 + 统计
│   ├── streamRewrite.ts      # 本地转发名映射
│   └── handlers/             # 每个业务 handler 一个文件
│       ├── list.ts / get.ts / create.ts / delete.ts
│       ├── toggle.ts / updateField.ts / updateHeaders.ts
│       ├── updateKey.ts / applyModels.ts / discover.ts / test.ts
│       ├── routes.ts / composites.ts / observability.ts
├── client/
│   ├── index.tsx             # apply(ctx) — remote $mount + settings.section Slot
│   ├── i18n.ts               # ZH / EN 字典
│   ├── styles.ts             # CSS 字符串
│   ├── labels.ts / rpc.ts / react.ts
│   └── components/
│       ├── ModelProPage.tsx    # 仪表盘（分段 + 新建 + 卡片）
│       ├── ProviderCard.tsx    # 状态色条卡片
│       ├── CreateForm.tsx      # 引导式 3 步向导
│       ├── ProviderEditor.tsx  # 标签页编辑器
│       ├── OverviewPanel.tsx / HeadersPanel.tsx / ModelsPanel.tsx
│       ├── TestPanel.tsx / RoutesPanel.tsx
tests/                        # host + client 冒烟测试
dist/                         # 构建输出（gitignored，随 npm 包发布）
scripts/
├── build.mjs                 # esbuild：host ESM + client __ModuleLoader__ 工厂
└── release.mjs               # 一键发版：bump + CHANGELOG + tag + push
tsconfig.json · package.json
```

---

## 📝 更新日志

见 [CHANGELOG.md](CHANGELOG.md)。

## 🔗 友情链接

- [Linux.do](https://linux.do/) — 真诚、友好、团结的 Linux 与开发者社区。

## License

[MIT](LICENSE)
