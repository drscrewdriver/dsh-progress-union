/**
 * 共享 mock 基座：纯内存 services 驱动 apply()，不起真宿主。
 * 形状对齐 l3j3y3/dsh-progress-board test/host.test.mjs 的 createHarness。
 */
import { apply } from '../index.js'

export const SESSION = 'session-union-test'

export function createHarness({ seed = {}, config = {}, withProjection = true, withProvide = true, storageless = false, llm = undefined, settings = undefined } = {}) {
  const records = { ...seed }
  const routes = new Map()
  const toolMap = new Map()
  const commandMap = new Map()
  const sections = new Map()
  const contexts = new Map()
  const listeners = []
  const agentHooks = []
  const provided = new Map()
  const projections = new Map()

  const unit = {
    async loadAll() {
      return { tables: { sessions: { ...records } } }
    },
    async putRecord(_table, key, record) {
      records[key] = record
    },
    async close() {},
  }

  const storage = storageless
    ? { backend: { names: () => [], get: () => ({}) } }
    : {
        backend: {
          names: () => ['json'],
          get: () => ({ kv: { open: async () => unit } }),
        },
      }

  const webServer = {
    register(route) {
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
  }

  const tools = {
    register(definition, options) {
      toolMap.set(definition.name, { definition, options })
      return () => toolMap.delete(definition.name)
    },
  }

  const commands = {
    register(definition) {
      commandMap.set(definition.name, definition)
      return () => commandMap.delete(definition.name)
    },
  }

  const systemPrompt = {}

  const agent = {
    id: SESSION,
    session: { id: SESSION },
    ctx: {
      effect(fn) {
        return fn()
      },
      systemPrompt: {
        section({ name, text }) {
          sections.set(name, text)
          return () => sections.delete(name)
        },
        context({ name, text }) {
          contexts.set(name, text)
          return () => contexts.delete(name)
        },
      },
      on(type, handler) {
        agentHooks.push({ type, handler })
        return () => {
          const index = agentHooks.findIndex((h) => h.type === type && h.handler === handler)
          if (index >= 0) agentHooks.splice(index, 1)
        }
      },
    },
  }

  const agents = { list: () => [agent] }

  const ctx = {
    get(name) {
      return { storage, webServer, systemPrompt, tools, agents, commands, llm, settings }[name]
    },
    on(type, handler) {
      listeners.push({ type, handler })
      return () => {
        const index = listeners.findIndex((h) => h.type === type && h.handler === handler)
        if (index >= 0) listeners.splice(index, 1)
      }
    },
    effect(fn) {
      const dispose = fn()
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
    inject(deps, callback) {
      if (withProjection && deps.includes('sessionProjections')) {
        callback({
          sessionProjections: {
            register(definition) {
              projections.set(definition.key, definition)
              return () => projections.delete(definition.key)
            },
          },
        })
      } else {
        callback({})
      }
    },
  }
  if (withProvide) {
    ctx.provide = (name, factory) => {
      provided.set(name, factory())
      return () => provided.delete(name)
    }
  }

  return {
    ctx,
    config,
    agent,
    records,
    routes,
    toolMap,
    commandMap,
    sections,
    contexts,
    listeners,
    agentHooks,
    provided,
    projections,
    run: () => apply(ctx, config),
    /** 按 (session, {type, data}) 派发一条 session/event */
    emit(type, data, session) {
      for (const h of listeners.filter((l) => l.type === 'session/event')) h.handler(session ?? { id: SESSION }, { type, data })
    },
  }
}

export function jsonReq(method, url, body) {
  const payload = Buffer.from(JSON.stringify(body))
  return {
    method,
    url,
    headers: { 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() {
      yield payload
    },
  }
}

export function getReq(url) {
  return { method: 'GET', url, headers: {} }
}

export function fakeRes() {
  return {
    status: 0,
    body: '',
    writeHead(status) {
      this.status = status
    },
    end(text) {
      this.body = text
    },
    json() {
      return JSON.parse(this.body || '{}')
    },
  }
}

export async function callRoute(harness, path, req) {
  const route = harness.routes.get(path)
  if (!route) throw new Error(`route not registered: ${path}`)
  const res = fakeRes()
  await route.handler(req, res)
  return res
}

export function withClock(fn) {
  const real = Date.now
  let offset = 0
  Date.now = () => real() + offset
  const advance = (ms) => {
    offset += ms
  }
  const restore = () => {
    Date.now = real
  }
  return { advance, restore, real }
}

export async function flush() {
  // 让 persist 写链落完
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
}
