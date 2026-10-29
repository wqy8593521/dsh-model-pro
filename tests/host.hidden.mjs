/**
 * tests/host.hidden.mjs — 隐藏模型（模型级"摘下 / 原样放回"）的契约。
 *
 * 这个功能的风险点全在"数据会不会丢"和"会不会把 llm-pi-ai 的配置写坏"上，两条
 * 都不能靠读代码确认，所以这里直接驱动真实的 handler：
 *
 *   1. 隐藏必须寄存**完整条目** —— `reasoningEfforts` / `compat` / `requestModel`
 *      以及手填的上限都不在 `discoverModels()` 的返回里，摘掉再靠"获取远端模型"
 *      加回来是拿不回的。
 *   2. 隐藏必须把该模型的**来源记录**一起寄存。摘除会把它从 capabilityStore 里
 *      删掉（`stateForCapabilities` 是整路由替换），不放回就会在"显示"时被重新
 *      判定成 `manual` —— 从此不再跟随目录更新。
 *   3. 不允许隐藏最后一个可见模型，而且这条规则对自定义 route 与内置目录 route
 *      **同样**成立：前者模型列表为空会让 llm-pi-ai 的配置校验直接失败，后者会
 *      静默回落到内置目录（"隐藏"反而让模型全部复活）。
 *   4. 卸载还原必须把隐藏条目并进**同一次**写，并在写成功后才清归档。
 *
 * Run: node scripts/run-node-test.mjs tests/host.hidden.mjs
 */

import assert from 'node:assert/strict'

import { applyModels } from '../src/host/handlers/applyModels.ts'
import { getProvider } from '../src/host/handlers/get.ts'
import { deleteProvider } from '../src/host/handlers/delete.ts'
import { restoreDisabledOnUnload } from '../src/host/lifecycle.ts'
import { bindConfigAccessor } from '../src/host/config.ts'
import { CAPABILITIES_KEY } from '../src/host/capabilityStore.ts'
import { HIDDEN_MODELS_KEY, ROUTES_KEY } from '../src/shared/constants.ts'

const NS = 'llm-pi-ai'
const OWN = 'dsh-model-pro'
const API = 'openai-completions'
const BASE = 'https://gw.example/v1'
const BINDING = JSON.stringify([API, BASE])

// ---------------------------------------------------------------------------
// settings double — raw (0.1) arm: `get` + `replace`, two namespaces
// ---------------------------------------------------------------------------
function createSettings(providers, owned = {}) {
  const store = {
    [NS]: structuredClone({ providers }),
    [OWN]: structuredClone(owned),
  }
  const writes = { llm: 0, own: 0 }
  return {
    writes,
    writable: true,
    get: (ns) => (ns in store ? structuredClone(store[ns]) : undefined),
    replace: async (ns, section) => {
      if (!(ns in store)) throw new Error(`unexpected ns: ${ns}`)
      writes[ns === NS ? 'llm' : 'own'] += 1
      const next = structuredClone(store[ns])
      for (const [k, v] of Object.entries(section)) next[k] = structuredClone(v)
      store[ns] = next
    },
    providers: () => structuredClone(store[NS].providers ?? {}),
    owned: () => structuredClone(store[OWN]),
  }
}

const makeCtx = (st, opts = {}) => ({
  get: (name) =>
    name === 'settings' ? st
      : name === 'llm' ? (opts.llm ?? { listConfigurableProviders: () => [], discoverModels: async () => [] })
        : name === 'agentDefaultModel' ? opts.defaultModel
          : name === 'logger' ? { warn: () => {} }
            : undefined,
})

/** 三个模型：a 有目录来源的能力记录，b 有手填的转发名与兼容设置，c 是裸条目。 */
const baseProviders = () => ({
  gw: {
    api: API,
    baseURL: BASE,
    models: [
      { id: 'a', name: 'A', contextWindow: 8192, maxTokens: 1024, input: ['text'], reasoningEfforts: { high: 'high' } },
      { id: 'b', name: 'B', requestModel: 'b-wire', compat: { supportsStore: true } },
      { id: 'c', name: 'C' },
    ],
  },
})

const baseOwned = () => ({
  [CAPABILITIES_KEY]: { gw: { binding: BINDING, models: { a: { wireId: 'a', input: ['text'], source: 'catalog' } } } },
})

const ids = (list) => list.map((m) => m.id)
const results = []
const check = async (label, fn) => {
  try {
    await fn()
    results.push({ label, ok: true })
  } catch (error) {
    results.push({ label, ok: false, error: error.message })
  }
}

// ---------------------------------------------------------------------------
// 1) 隐藏：寄存完整条目 + 来源记录，存活条目的记录不受影响
// ---------------------------------------------------------------------------
await check('hide 摘出条目并寄存完整数据（含 reasoningEfforts / compat / requestModel）', async () => {
  const st = createSettings(baseProviders(), baseOwned())
  bindConfigAccessor(st)
  const ctx = makeCtx(st)

  const r = await applyModels(ctx, { route: 'gw', models: [{ id: 'a' }, { id: 'c' }], mode: 'hide' })
  assert.equal(r.ok, true, r.error)
  assert.equal(r.hidden, 2)
  assert.deepEqual(ids(st.providers().gw.models), ['b'])

  const parked = st.owned()[HIDDEN_MODELS_KEY].gw
  assert.equal(parked.binding, BINDING, 'bindging 必须记下摘除时的端点绑定')
  assert.deepEqual(parked.entries.map((e) => e.index), [0, 2], '原位下标必须保留')
  const a = parked.entries.find((e) => e.model.id === 'a').model
  assert.deepEqual(a.reasoningEfforts, { high: 'high' })
  assert.deepEqual(a.input, ['text'])
  assert.equal(a.contextWindow, 8192)
  const c = parked.entries.find((e) => e.model.id === 'c').model
  assert.equal(c.id, 'c')

  // 来源记录随条目一起寄存，并从 active 状态里移走（整路由替换）
  const parkedA = parked.entries.find((e) => e.model.id === 'a')
  assert.equal(parkedA.capability?.source, 'catalog')
  assert.equal(st.owned()[CAPABILITIES_KEY].gw, undefined, '该 route 已无存活来源记录时应清空')
})

await check('hide 保留存活条目的来源记录', async () => {
  const st = createSettings(baseProviders(), baseOwned())
  bindConfigAccessor(st)
  const ctx = makeCtx(st)

  const r = await applyModels(ctx, { route: 'gw', models: [{ id: 'b' }], mode: 'hide' })
  assert.equal(r.ok, true, r.error)
  assert.equal(st.owned()[CAPABILITIES_KEY].gw.models.a.source, 'catalog')
})

// ---------------------------------------------------------------------------
// 2) 最后一个可见模型：两种 route 都被拒绝
// ---------------------------------------------------------------------------
await check('hide 的计数含义：hidden 是归档总量，parked 是本次摘下的数量', async () => {
  const st = createSettings(baseProviders(), baseOwned())
  bindConfigAccessor(st)
  const ctx = makeCtx(st)

  const first = await applyModels(ctx, { route: 'gw', models: [{ id: 'a' }], mode: 'hide' })
  assert.equal(first.parked, 1, '本次摘下 1 个')
  assert.equal(first.hidden, 1)

  const second = await applyModels(ctx, { route: 'gw', models: [{ id: 'c' }], mode: 'hide' })
  assert.equal(second.parked, 1, '本次仍然只摘下 1 个')
  assert.equal(second.hidden, 2, '归档总量是状态事实，与本次动作数量分开报告')
})

await check('hide 拒绝隐藏最后一个可见模型（自定义 route）', async () => {
  const st = createSettings({ gw: { api: API, baseURL: BASE, models: [{ id: 'only' }] } })
  bindConfigAccessor(st)
  const ctx = makeCtx(st, { llm: { listConfigurableProviders: () => [{ settingsNs: NS, provider: 'gw', declared: true }], discoverModels: async () => [] } })

  const r = await applyModels(ctx, { route: 'gw', models: [{ id: 'only' }], mode: 'hide' })
  assert.equal(r.ok, false)
  assert.match(r.error, /不能隐藏最后一个可见模型/)
  assert.deepEqual(ids(st.providers().gw.models), ['only'], '被拒绝时不得改动任何配置')
})

await check('hide 拒绝隐藏最后一个可见模型（内置目录 route，同一条规则）', async () => {
  const st = createSettings({ deepseek: { api: API, baseURL: BASE, models: [{ id: 'deepseek-chat' }] } })
  bindConfigAccessor(st)
  const ctx = makeCtx(st, { llm: { listConfigurableProviders: () => [{ settingsNs: NS, provider: 'deepseek', declared: false }], discoverModels: async () => [] } })

  const r = await applyModels(ctx, { route: 'deepseek', models: [{ id: 'deepseek-chat' }], mode: 'hide' })
  assert.equal(r.ok, false)
  assert.match(r.error, /不能隐藏最后一个可见模型/)
  assert.doesNotMatch(r.error, /不能删除全部模型/, '不能掉进"删除"语义的旧报错，两种 route 的规则必须一致')
})

// ---------------------------------------------------------------------------
// 3) 显示：原位放回 + 来源不被降级成 manual
// ---------------------------------------------------------------------------
await check('show 按原下标放回，且手填字段原样保留', async () => {
  const st = createSettings(baseProviders(), baseOwned())
  bindConfigAccessor(st)
  const ctx = makeCtx(st)

  assert.equal((await applyModels(ctx, { route: 'gw', models: [{ id: 'b' }], mode: 'hide' })).ok, true)
  assert.deepEqual(ids(st.providers().gw.models), ['a', 'c'])
  const r = await applyModels(ctx, { route: 'gw', models: [{ id: 'b' }], mode: 'show' })
  assert.equal(r.ok, true, r.error)
  assert.equal(r.restored, 1)
  assert.deepEqual(ids(st.providers().gw.models), ['a', 'b', 'c'], 'b 必须回到原来的下标 1')
  const b = st.providers().gw.models[1]
  assert.equal(b.requestModel, 'b-wire')
  assert.deepEqual(b.compat, { supportsStore: true })
  assert.deepEqual(st.owned()[HIDDEN_MODELS_KEY], {}, '归档清空')
})

await check('show 恢复来源记录，且不把它降级成 manual', async () => {
  const st = createSettings(baseProviders(), baseOwned())
  bindConfigAccessor(st)
  const ctx = makeCtx(st)

  assert.equal((await applyModels(ctx, { route: 'gw', models: [{ id: 'a' }], mode: 'hide' })).ok, true)
  assert.equal((await applyModels(ctx, { route: 'gw', models: [{ id: 'a' }], mode: 'show' })).ok, true)

  const record = st.owned()[CAPABILITIES_KEY].gw.models.a
  assert.equal(record.source, 'catalog', 'catalog 来源必须存活；被改写成 manual 就等于人工锁死，不再跟随目录')
  assert.deepEqual(st.providers().gw.models[0].input, ['text'])
  assert.deepEqual(st.owned()[HIDDEN_MODELS_KEY], {}, '归档清空后不再有任何条目')
})

await check('show 是幂等的：用户期间已重新加回的 id 不会被插两次', async () => {
  const st = createSettings(baseProviders(), baseOwned())
  bindConfigAccessor(st)
  const ctx = makeCtx(st)

  assert.equal((await applyModels(ctx, { route: 'gw', models: [{ id: 'b' }], mode: 'hide' })).ok, true)
  // 用户通过"获取远端模型 → 合并选中"把 b 加回来了
  assert.equal((await applyModels(ctx, { route: 'gw', models: [{ id: 'b', name: 'B2' }], mode: 'merge' })).ok, true)
  assert.deepEqual(ids(st.providers().gw.models), ['a', 'c', 'b'])
  assert.deepEqual(st.owned()[HIDDEN_MODELS_KEY], {}, '重新加回即视为显示：归档必须同步清掉')
  assert.equal(st.providers().gw.models[2].name, 'B2', '以用户现条目为准，不用归档里的旧条目覆盖')

  const again = await applyModels(ctx, { route: 'gw', models: [{ id: 'b' }], mode: 'show' })
  assert.equal(again.ok, false)
  assert.match(again.error, /不在已隐藏列表/)
})

// ---------------------------------------------------------------------------
// 4) 拒绝隐藏仍有引用的模型
// ---------------------------------------------------------------------------
await check('hide 拒绝隐藏被智能路由引用的模型', async () => {
  const st = createSettings(baseProviders(), { ...baseOwned(), [ROUTES_KEY]: { fast: { strategy: 'priority', targets: [{ provider: 'gw', model: 'b' }] } } })
  bindConfigAccessor(st)
  const ctx = makeCtx(st)

  const r = await applyModels(ctx, { route: 'gw', models: [{ id: 'b' }], mode: 'hide' })
  assert.equal(r.ok, false)
  assert.match(r.error, /路由别名「fast」/)
  assert.deepEqual(st.owned()[HIDDEN_MODELS_KEY], undefined, '被拒绝时不得留下半截归档')
})

await check('hide 拒绝隐藏当前默认模型', async () => {
  const st = createSettings(baseProviders(), baseOwned())
  bindConfigAccessor(st)
  const ctx = makeCtx(st, { defaultModel: { currentSelection: () => ({ provider: 'gw', model: 'b' }) } })

  const r = await applyModels(ctx, { route: 'gw', models: [{ id: 'b' }], mode: 'hide' })
  assert.equal(r.ok, false)
  assert.match(r.error, /默认模型/)
})

await check('hide 拒绝把内部占位条目当成可隐藏模型', async () => {
  const st = createSettings({ gw: { api: API, baseURL: BASE, models: [{ id: 'placeholder' }, { id: 'a' }] } })
  bindConfigAccessor(st)
  const ctx = makeCtx(st)

  const r = await applyModels(ctx, { route: 'gw', models: [{ id: 'placeholder' }], mode: 'hide' })
  assert.equal(r.ok, false)
  assert.match(r.error, /占位条目/)
  assert.deepEqual(st.owned()[HIDDEN_MODELS_KEY], undefined)
})

await check('hide 对不存在的 id 报错，不改动配置', async () => {
  const st = createSettings(baseProviders(), baseOwned())
  bindConfigAccessor(st)
  const ctx = makeCtx(st)

  const r = await applyModels(ctx, { route: 'gw', models: [{ id: 'nope' }], mode: 'hide' })
  assert.equal(r.ok, false)
  assert.match(r.error, /不在当前列表中/)
  assert.deepEqual(st.owned()[HIDDEN_MODELS_KEY], undefined)
})

// ---------------------------------------------------------------------------
// 5) 卸载还原：并入同一次写，写成功后才清归档
// ---------------------------------------------------------------------------
await check('卸载还原把隐藏条目并进同一写，并清空归档', async () => {
  const st = createSettings(
    { gw: { api: API, baseURL: BASE, models: [{ id: 'a' }] } },
    {
      ...baseOwned(),
      [HIDDEN_MODELS_KEY]: { gw: { binding: BINDING, entries: [{ index: 1, model: { id: 'b', requestModel: 'b-wire' } }] } },
      disabledProviders: { parked: { api: API, baseURL: 'https://parked.example/v1', models: [{ id: 'p' }] } },
    },
  )
  bindConfigAccessor(st)
  const ctx = makeCtx(st)
  const before = st.writes.llm

  const r = await restoreDisabledOnUnload(ctx)
  assert.equal(r.hiddenRestored, 1)
  assert.equal(r.restored, 1)
  assert.equal(st.writes.llm - before, 1, '提供商还原与模型还原必须在同一次写里落地')
  assert.deepEqual(ids(st.providers().gw.models), ['a', 'b'])
  assert.equal(st.providers().gw.models[1].requestModel, 'b-wire')
  assert.deepEqual(ids(st.providers().parked.models), ['p'], '被禁用的提供商照旧整体还原')
  assert.deepEqual(st.owned()[HIDDEN_MODELS_KEY], {}, '还原成功后归档必须清空')
  assert.deepEqual(st.owned().disabledProviders, {}, '禁用寄存区同步清空')
})

await check('卸载还原对已存在的 id 幂等（不重复插入）', async () => {
  const st = createSettings(
    { gw: { api: API, baseURL: BASE, models: [{ id: 'a' }, { id: 'b' }] } },
    { [HIDDEN_MODELS_KEY]: { gw: { binding: BINDING, entries: [{ index: 1, model: { id: 'b' } }, { index: 2, model: { id: 'c' } }] } } },
  )
  bindConfigAccessor(st)
  const ctx = makeCtx(st)

  const r = await restoreDisabledOnUnload(ctx)
  assert.equal(r.hiddenRestored, 1)
  assert.deepEqual(ids(st.providers().gw.models), ['a', 'b', 'c'])
  assert.deepEqual(st.owned()[HIDDEN_MODELS_KEY], {})
})

// ---------------------------------------------------------------------------
// 6) 归档生命周期：删除提供商 / 新建同名提供商
// ---------------------------------------------------------------------------
await check('删除提供商会清掉它的归档（不留孤儿条目）', async () => {
  const st = createSettings(
    { gw: { api: API, baseURL: BASE, models: [{ id: 'a' }] } },
    { [HIDDEN_MODELS_KEY]: { gw: { binding: BINDING, entries: [{ index: 1, model: { id: 'b' } }] } } },
  )
  bindConfigAccessor(st)
  const ctx = makeCtx(st)

  const r = await deleteProvider(ctx, { route: 'gw' })
  assert.equal(r.ok, true, r.error)
  assert.deepEqual(st.owned()[HIDDEN_MODELS_KEY], {})
})

// ---------------------------------------------------------------------------
// 7) 读侧：编辑器能拿到寄存的完整条目
// ---------------------------------------------------------------------------
await check('get-provider 返回已隐藏条目（含原下标与手填字段）', async () => {
  const st = createSettings(baseProviders(), baseOwned())
  bindConfigAccessor(st)
  const ctx = makeCtx(st)

  assert.equal((await applyModels(ctx, { route: 'gw', models: [{ id: 'b' }], mode: 'hide' })).ok, true)
  const data = await getProvider(ctx, { route: 'gw' })
  assert.deepEqual(ids(data.models), ['a', 'c'])
  assert.equal(data.hiddenModels.length, 1)
  assert.equal(data.hiddenModels[0].id, 'b')
  assert.equal(data.hiddenModels[0].index, 1)
  assert.equal(data.hiddenModels[0].requestModel, 'b-wire')
  assert.equal(data.hiddenModels[0].capability, undefined, '内部来源记录不进入展示层')
})

// ---------------------------------------------------------------------------
// 8) 归档不能泄漏成 llm-pi-ai 的键
// ---------------------------------------------------------------------------
await check('隐藏只写自有分区，不动 llm-pi-ai 的其它键', async () => {
  const st = createSettings({ gw: { api: API, baseURL: BASE, models: [{ id: 'a' }, { id: 'b' }] } })
  bindConfigAccessor(st)
  const ctx = makeCtx(st)

  assert.equal((await applyModels(ctx, { route: 'gw', models: [{ id: 'b' }], mode: 'hide' })).ok, true)
  assert.deepEqual(Object.keys(st.get(NS)), ['providers'], 'llm-pi-ai 只能有 providers 这一个键')
  assert.deepEqual(Object.keys(st.providers().gw).sort(), ['api', 'baseURL', 'models'])
})

// --- report -----------------------------------------------------------------
let failed = 0
for (const r of results) {
  if (r.ok) console.log(`  ok   ${r.label}`)
  else {
    failed += 1
    console.log(`  FAIL ${r.label}\n       ${r.error}`)
  }
}
if (failed === 0) {
  console.log(`PASS: hidden models — ${results.length}/${results.length} green`)
} else {
  console.log(`FAIL: hidden models — ${failed}/${results.length} failed`)
  process.exit(1)
}