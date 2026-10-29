/**
 * tests/host.modelcap-batch.mjs — 模型列表的能力描述必须是"一次设置读取"，而不是
 * "每个模型一次"。
 *
 * 为什么值得一条独立的测试：这是"模型很多时进入模型编辑会卡顿"的根因，而且**功能
 * 完全正确、只有性能变坏** —— 没有断言就只会以"慢"的形式被感觉到。DSH 0.2 上
 * 每一次设置读取都是一次 `describe()`（把整个设置文档投影成各 section 的已声明
 * 字段），所以 `get-provider` 对 300 个模型逐个 `describeModelInput` 会变成上千次
 * 投影，而不是几十次。
 *
 * 断言的是**次数上界**而不是精确值：多读一两次无害，退化回 O(模型数) 立刻失败。
 *
 * Run: node scripts/run-node-test.mjs tests/host.modelcap-batch.mjs
 */

import assert from 'node:assert/strict'

import { getProvider } from '../src/host/handlers/get.ts'
import { discoverModels } from '../src/host/handlers/discover.ts'
import { bindConfigAccessor } from '../src/host/config.ts'
import { CAPABILITIES_KEY } from '../src/host/capabilityStore.ts'

const NS = 'llm-pi-ai'
const OWN = 'dsh-model-pro'
const API = 'openai-completions'
const BASE = 'https://gw.example/v1'

/** 60 个模型的提供商 —— 足够让 O(N) 的读取次数和常量级次数分得开。 */
const MODEL_COUNT = 60

function createCountingSettings() {
  const models = Array.from({ length: MODEL_COUNT }, (_, i) => ({
    id: `m${String(i).padStart(2, '0')}`,
    name: `Model ${i}`,
    contextWindow: 8192,
    maxTokens: 2048,
    // 第一个模型声明了能力并有来源记录 —— 用来证明批量路径没有顺手丢掉展示信息。
    ...(i === 0 ? { input: ['text', 'image'] } : {}),
  }))
  const store = {
    [NS]: { providers: { gw: { api: API, baseURL: BASE, models } } },
    [OWN]: { [CAPABILITIES_KEY]: { gw: { binding: JSON.stringify([API, BASE]), models: { m00: { wireId: 'm00', input: ['text', 'image'], source: 'catalog' } } } } },
  }
  const reads = { total: 0, byNs: {} }
  return {
    store,
    reads,
    writable: true,
    get: (ns) => {
      reads.total += 1
      reads.byNs[ns] = (reads.byNs[ns] ?? 0) + 1
      return ns in store ? structuredClone(store[ns]) : undefined
    },
    replace: async (ns, section) => {
      if (!(ns in store)) throw new Error(`unexpected ns: ${ns}`)
      for (const [k, v] of Object.entries(section)) store[ns][k] = structuredClone(v)
    },
  }
}

const makeCtx = (st, opts = {}) => ({
  get: (name) =>
    name === 'settings' ? st
      : name === 'llm' ? (opts.llm ?? {
        listConfigurableProviders: () => [{ settingsNs: NS, provider: 'gw', declared: true }],
        discoverModels: async () => [],
        listModels: async () => [],
      })
        : undefined,
})

const results = []
const check = async (label, fn) => {
  try {
    await fn()
    results.push({ label, ok: true })
  } catch (error) {
    results.push({ label, ok: false, error: error.message })
  }
}

await check(`get-provider 描述 ${MODEL_COUNT} 个模型只读少量几次设置`, async () => {
  const st = createCountingSettings()
  bindConfigAccessor(st)
  const ctx = makeCtx(st)

  const data = await getProvider(ctx, { route: 'gw' })
  assert.equal(data.ok, true, data.error)
  assert.equal(data.models.length, MODEL_COUNT, '每个模型都要出现在结果里')

  // 退化成每模型一次读取时的数量级：3 * 60 = 180+。
  assert.ok(
    st.reads.total <= 12,
    `设置读取次数必须与模型数无关（常量级），实际 ${st.reads.total} 次（${MODEL_COUNT} 个模型）`,
  )

  // 性能修复不能顺手丢掉能力展示信息。
  const known = data.models.find((m) => m.id === 'm00')
  assert.deepEqual(known.input, ['text', 'image'], '声明的能力必须仍然带出来')
  assert.equal(known.capabilitySource, 'catalog', '已记录的来源必须仍然带出来')
  const unknown = data.models.find((m) => m.id === 'm01')
  assert.equal(unknown.capabilitySource, undefined, '未声明的模型不造假来源')
})

await check('discover-models 描述整份发现结果也只读常量级次数', async () => {
  const st = createCountingSettings()
  bindConfigAccessor(st)
  const discovered = Array.from({ length: MODEL_COUNT }, (_, i) => ({ id: `r${i}`, name: `Remote ${i}` }))
  const ctx = makeCtx(st, { llm: {
    listConfigurableProviders: () => [],
    discoverModels: async () => discovered,
    listModels: async () => [],
  } })

  const r = await discoverModels(ctx, { route: 'gw' })
  assert.equal(r.ok, true, r.error)
  assert.equal(r.models.length, MODEL_COUNT)
  assert.ok(st.reads.total <= 12, `发现流程的设置读取也必须与模型数无关，实际 ${st.reads.total} 次`)
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
if (failed === 0) console.log(`PASS: capability view batching — ${results.length}/${results.length} green`)
else {
  console.log(`FAIL: capability view batching — ${failed}/${results.length} failed`)
  process.exit(1)
}