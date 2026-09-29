import type { Plugin, PluginModule } from "@opencode-ai/plugin"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

// ---------------------------------------------------------------------------
// Telegram Notify Plugin for OpenCode
//
// Push + interactive notifications:
//   - session.idle        -> agent finished (with inline keyboard)
//   - session.error       -> session error
//   - permission.updated  -> allow / deny buttons
//
// Interactive (long-poll getUpdates):
//   - text message        -> sent as a user prompt to the active session
//   - <button> agent      -> pick agent for the next prompt (per-prompt)
//   - <button> continue   -> ask the agent to continue
//   - <button> abort      -> abort the running session
//   - <button> allow/reject -> replies to a pending permission request
//
// Every inbound update (text or callback) is checked against config.chatId;
// updates from any other chat are dropped.
// ---------------------------------------------------------------------------

const CONFIG_PATH = join(homedir(), ".config", "opencode", "telegram-notify.json")
const BOT_NAME = "notifier"
const POLL_INTERVAL_MS = 2000
const POLL_TIMEOUT_MS = 30000
const MAX_MESSAGE_CHARS = 4000

interface TelegramConfig {
  botToken: string
  chatId: string
}

// ---- Config loading -------------------------------------------------------

function loadConfig(client: any): TelegramConfig | null {
  const envBotToken = process.env.TELEGRAM_BOT_TOKEN
  const envChatId = process.env.TELEGRAM_CHAT_ID
  if (envBotToken && envChatId) {
    return { botToken: envBotToken, chatId: envChatId }
  }
  try {
    const raw = readFileSync(CONFIG_PATH, "utf-8")
    const parsed = JSON.parse(raw)
    if (!parsed.botToken || !parsed.chatId) {
      client.app.log({
        body: {
          service: BOT_NAME,
          level: "error",
          message: `telegram-notify.json is missing botToken or chatId fields`,
        },
      })
      return null
    }
    return { botToken: parsed.botToken, chatId: parsed.chatId }
  } catch (err: any) {
    if (err.code === "ENOENT") {
      client.app.log({
        body: {
          service: BOT_NAME,
          level: "error",
          message: `Config file not found at ${CONFIG_PATH}. Create it with { "botToken": "...", "chatId": "..." }`,
        },
      })
    } else {
      client.app.log({
        body: {
          service: BOT_NAME,
          level: "error",
          message: `Failed to read config: ${err.message}`,
        },
      })
    }
    return null
  }
}

// ---- Telegram API ---------------------------------------------------------

interface InlineKeyboardButton {
  text: string
  callback_data: string
}

type InlineKeyboard = InlineKeyboardButton[][]

interface TelegramResult {
  ok: boolean
  result?: any
  description?: string
  error_code?: number
}

/** Generic Telegram Bot API call. Never throws, always bounded by a timeout. */
async function tg(
  botToken: string,
  method: string,
  body: Record<string, any> = {},
  timeoutMs: number = 20000
): Promise<TelegramResult | null> {
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const res = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      })
      return (await res.json()) as TelegramResult
    } finally {
      clearTimeout(timer)
    }
  } catch {
    return null
  }
}

function sendMessage(
  botToken: string,
  chatId: string,
  text: string,
  keyboard?: InlineKeyboard
): Promise<TelegramResult | null> {
  return tg(botToken, "sendMessage", {
    chat_id: chatId,
    text: truncateForTelegram(text),
    ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
  })
}

function editMessage(
  botToken: string,
  chatId: string,
  messageId: number,
  text: string,
  keyboard?: InlineKeyboard
): Promise<TelegramResult | null> {
  return tg(botToken, "editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text: truncateForTelegram(text),
    ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
  })
}

function answerCallbackQuery(
  botToken: string,
  callbackQueryId: string,
  text?: string
): Promise<TelegramResult | null> {
  return tg(botToken, "answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    ...(text ? { text } : {}),
  })
}

// ---- Helpers --------------------------------------------------------------

/** Fetch session title by sessionID */
async function getSessionTitle(client: any, sessionID: string): Promise<string> {
  try {
    const res = await client.session.get({ path: { id: sessionID } })
    const data = res.data
    if (data && data.title) return data.title
  } catch {
    // ignore
  }
  return "unknown session"
}

/** Fetch the most recent assistant text reply from a session */
async function getLastAssistantText(client: any, sessionID: string): Promise<string> {
  try {
    const res = await client.session.messages({
      path: { id: sessionID },
      query: { limit: 20 },
    })
    const messages = res.data
    if (Array.isArray(messages)) {
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]
        if (msg.info.role === "assistant") {
          const textPart = msg.parts.find((p: any) => p.type === "text")
          if (textPart && textPart.text) {
            return textPart.text
          }
        }
      }
    }
  } catch {
    // ignore
  }
  return "(no text response)"
}

/** Extract a human-readable error message from the discriminated error union */
function extractErrorMessage(error: any): string {
  if (!error) return "Unknown error (no error object)"
  const data = error.data || {}
  if (data.message) {
    return data.statusCode ? `${data.message} (HTTP ${data.statusCode})` : data.message
  }
  return error.name || "UnknownError"
}

/** Truncate text to roughly maxWords words */
function truncateToWords(text: string, maxWords: number = 20): string {
  const words = text.split(/\s+/).filter(Boolean)
  if (words.length <= maxWords) return text
  return words.slice(0, maxWords).join(" ") + "..."
}

/** Truncate text to Telegram's 4096-char message limit (codepoint-safe) */
function truncateForTelegram(text: string, maxChars: number = MAX_MESSAGE_CHARS): string {
  const chars = Array.from(text)
  if (chars.length <= maxChars) return text
  return chars.slice(0, maxChars).join("") + "…"
}

/** List available agents for inline buttons */
async function listAgents(client: any): Promise<string[]> {
  try {
    const res = await client.app.agents()
    const data = res.data
    if (Array.isArray(data.agents)) return data.agents.map((a: any) => a.name)
    if (Array.isArray(data)) return data.map((a: any) => a.name)
  } catch {
    // ignore
  }
  return []
}

/** List sessions, newest first */
async function listSessions(client: any): Promise<any[]> {
  try {
    const res = await client.session.list({})
    if (Array.isArray(res.data)) {
      return res.data.slice().sort(
        (a: any, b: any) => (b?.time?.updated ?? 0) - (a?.time?.updated ?? 0)
      )
    }
  } catch {
    // ignore
  }
  return []
}

/** The session text replies should target */
function replyTarget(): string | null {
  return targetSessionID ?? activeSessionID
}

// ---- Anti-spam state ------------------------------------------------------

let lastIdleSummary: string | null = null
let lastIdleSessionID: string | null = null

// ---- Interactive state -----------------------------------------------------

/** telegram message id -> sessionID */
const sessionByMessageId = new Map<number, string>()
/** sessionID -> preferred agent (used as per-prompt override) */
const agentBySession = new Map<string, string>()
/** telegram message id -> permission id for allow/reject buttons */
const permissionByMessageId = new Map<number, string>()
/** sessionID -> telegram message id of the last idle notification */
const messageIdBySession = new Map<string, number>()
/** most recent session that went idle, i.e. the "active" target for replies */
let activeSessionID: string | null = null
/** explicitly chosen reply target (via /sessions), overrides activeSessionID */
let targetSessionID: string | null = null
/** last processed telegram update_id */
let lastUpdateId = 0

// ---- Interactive actions ----------------------------------------------------

/** Reply to a pending permission request ("once" | "always" | "reject") */
async function replyPermission(
  client: any,
  sessionID: string,
  permissionId: string,
  response: "once" | "always" | "reject"
): Promise<boolean> {
  try {
    await client.postSessionIdPermissionsPermissionId({
      path: { id: sessionID, permissionId },
      body: { response },
    })
    return true
  } catch {
    return false
  }
}

/**
 * Switch the agent for a session.
 * Prefers the (undocumented) runtime client.session.switchAgent; falls back
 * to recording a per-prompt override used by dispatchPrompt.
 */
async function switchAgent(client: any, sessionID: string, agent: string): Promise<boolean> {
  try {
    const sessionApi: any = client.session
    if (typeof sessionApi.switchAgent === "function") {
      const res = await sessionApi.switchAgent({
        path: { id: sessionID },
        body: { agent },
      })
      if (!res || res.error) return false
      agentBySession.delete(sessionID)
      return true
    }
  } catch {
    // fall through to per-prompt override
  }
  agentBySession.set(sessionID, agent)
  return false
}

/** Inject a user prompt into a session asynchronously (reply-to-OpenCode). */
async function dispatchPrompt(
  client: any,
  sessionID: string,
  text: string
): Promise<boolean> {
  const agent = agentBySession.get(sessionID)
  try {
    await client.session.promptAsync({
      path: { id: sessionID },
      body: {
        parts: [{ type: "text", text }],
        ...(agent ? { agent } : {}),
      },
    })
    return true
  } catch {
    return false
  }
}

async function handleTextMessage(
  client: any,
  config: TelegramConfig,
  chatId: string,
  text: string
): Promise<void> {
  // Ignore anything that is not from the configured chat. Without this, any
  // user who finds the bot can drive the agent (including Bash and file edits).
  if (chatId !== config.chatId) return

  const trimmed = text.trim()

  if (trimmed === "/new") {
    let created: string | null = null
    try {
      const res = await client.session.create({
        body: { ...(activeSessionID ? { parentID: activeSessionID } : {}) },
      })
      created = res.data?.id || null
    } catch {
      created = null
    }
    if (created) {
      activeSessionID = created
      agentBySession.delete(created)
      await sendMessage(
        config.botToken,
        chatId,
        `🗂 New session started: ${await getSessionTitle(client, created)}`,
        await buildIdleKeyboard(client, created)
      )
    } else {
      await sendMessage(
        config.botToken,
        chatId,
        `Failed to create a session`,
        activeSessionID ? await buildIdleKeyboard(client, activeSessionID) : undefined
      )
    }
    return
  }

  if (trimmed === "/agents") {
    const agents = await listAgents(client)
    await sendMessage(
      config.botToken,
      chatId,
      agents.length
        ? `Agents: ${agents.join(", ")}`
        : `No agents found.`,
      await buildIdleKeyboard(client, replyTarget())
    )
    return
  }

  if (trimmed === "/sessions") {
    const sessions = await listSessions(client)
    if (sessions.length === 0) {
      await sendMessage(config.botToken, chatId, `No sessions found — open opencode first or use /new.`)
      return
    }
    const keyboard = buildSessionKeyboard(sessions, replyTarget())
    await sendMessage(
      config.botToken,
      chatId,
      `Select a session to talk to:\n\nCurrent: ${await getSessionTitle(client, replyTarget() ?? "")}\n(Your text messages will go to the selected session until you pick "Latest".)`,
      keyboard
    )
    return
  }

  if (trimmed === "/reset") {
    targetSessionID = null
    await sendMessage(
      config.botToken,
      chatId,
      `Reply target reset — text messages now go to the most recent session.`,
      await buildIdleKeyboard(client, activeSessionID)
    )
    return
  }

  if (trimmed.startsWith("/")) {
    await sendMessage(
      config.botToken,
      chatId,
      `Unknown command. Try /new, /sessions, /agents, or just type a message.`,
      await buildIdleKeyboard(client, replyTarget())
    )
    return
  }

  const target = replyTarget()
  if (!target) {
    await sendMessage(config.botToken, chatId, `No active session yet — open opencode first or use /new.`)
    return
  }

  await sendMessage(
    config.botToken,
    chatId,
    `⏳ Sent to ${await getSessionTitle(client, target)}...`
  )
  const ok = await dispatchPrompt(client, target, trimmed)
  if (!ok) {
    await sendMessage(config.botToken, chatId, `Failed to send the message to the session.`)
  }
}

async function handleCallbackQuery(
  client: any,
  config: TelegramConfig,
  callbackQuery: any
): Promise<void> {
  const { id: callbackId, message, from } = callbackQuery
  const data = resolveCallbackData(callbackQuery.data)
  const chatId = String(message?.chat?.id ?? from?.id)
  const messageId: number | undefined = message?.message_id

  if (chatId !== config.chatId) {
    await answerCallbackQuery(config.botToken, callbackId, `Not authorized`)
    return
  }

  const sessionID = messageId !== undefined ? sessionByMessageId.get(messageId) : undefined

  // --- permission allow/reject ---
  if (data === "allow" || data === "always" || data === "reject") {
    const permissionId = messageId !== undefined ? permissionByMessageId.get(messageId) : undefined
    const target =
      sessionID ?? activeSessionID ?? (permissionId ? lastIdleSessionID : null)
    if (!target || !permissionId) {
      await answerCallbackQuery(config.botToken, callbackId, `Permission request is gone`)
      return
    }
    await answerCallbackQuery(config.botToken, callbackId, `⏳ Processing...`)
    const response = data === "reject" ? "reject" : data === "always" ? "always" : "once"
    const ok = await replyPermission(client, target, permissionId, response)
    if (messageId !== undefined) {
      await editMessage(
        config.botToken,
        chatId,
        messageId,
        ok
          ? `Permission: ${data === "reject" ? "🚫 Rejected" : data === "always" ? "✅ Allowed (always)" : "✅ Allowed (once)"}`
          : `Permission: ⚠️ Failed to reply`
      )
      if (ok) permissionByMessageId.delete(messageId)
    }
    return
  }

  // --- abort ---
  if (data === "abort") {
    const target = sessionID ?? replyTarget()
    if (!target) {
      await answerCallbackQuery(config.botToken, callbackId, `No session to abort`)
      return
    }
    await answerCallbackQuery(config.botToken, callbackId, `🛑 Aborting...`)
    try {
      await client.session.abort({ path: { id: target } })
      if (messageId !== undefined) {
        await editMessage(
          config.botToken,
          chatId,
          messageId,
          `🛑 Aborted: ${await getSessionTitle(client, target)}`
        )
        sessionByMessageId.delete(messageId)
      }
      messageIdBySession.delete(target)
    } catch {
      // keep the notification as-is; the callback was already acknowledged
    }
    return
  }

  // --- continue ---
  if (data === "continue") {
    const target = sessionID ?? replyTarget()
    if (!target) {
      await answerCallbackQuery(config.botToken, callbackId, `No session to continue`)
      return
    }
    await answerCallbackQuery(config.botToken, callbackId, `Continuing...`)
    await dispatchPrompt(client, target, "continue")
    if (messageId !== undefined) {
      await editMessage(config.botToken, chatId, messageId, `🔁 Continue requested...`)
    }
    return
  }

  // --- pick a specific session to talk to ---
  if (data?.startsWith("session:")) {
    const id = data.slice("session:".length)
    if (id === "latest") {
      targetSessionID = null
      await answerCallbackQuery(config.botToken, callbackId, `Replies now go to the most recent session`)
      if (messageId !== undefined) {
        await editMessage(config.botToken, chatId, messageId, `Reply target reset to the most recent session.`)
      }
      return
    }
    targetSessionID = id
    activeSessionID = id
    await answerCallbackQuery(config.botToken, callbackId, `💬 Talking to: ${await getSessionTitle(client, id)}`)
    if (messageId !== undefined) {
      await editMessage(
        config.botToken,
        chatId,
        messageId,
        `💬 Now chatting with: ${await getSessionTitle(client, id)}\n\nYour text messages will be sent to this session.`
      )
    }
    return
  }

  // --- plan / build mode toggle ---
  if (data === "mode:plan" || data === "mode:build") {
    const mode = data.slice("mode:".length)
    const target = sessionID ?? replyTarget()
    if (!target) {
      await answerCallbackQuery(config.botToken, callbackId, `No session selected`)
      return
    }
    await answerCallbackQuery(config.botToken, callbackId, `Setting mode to ${mode}...`)
    const persisted = await switchAgent(client, target, mode)
    if (messageId !== undefined) {
      await editMessage(
        config.botToken,
        chatId,
        messageId,
        persisted
          ? `Switched session to ${mode === "plan" ? "🧠 plan" : "🛠 build"} mode`
          : `${mode === "plan" ? "🧠 plan" : "🛠 build"} mode set for next prompt`
      )
    }
    return
  }

  // --- agent switch ---
  if (data?.startsWith("agent:")) {
    const agent = data.slice("agent:".length)
    const target = sessionID ?? replyTarget()
    if (!target) {
      await answerCallbackQuery(config.botToken, callbackId, `No session selected`)
      return
    }
    const persisted = await switchAgent(client, target, agent)
    await answerCallbackQuery(
      config.botToken,
      callbackId,
      persisted ? `Switched session agent to ${agent}` : `Agent set for next prompt: ${agent}`
    )
    return
  }

  await answerCallbackQuery(config.botToken, callbackId)
}

// ---- Keyboard builders ----------------------------------------------------

/** callback_data string -> full action (for keys truncated to fit 64 bytes) */
const actionByData = new Map<string, string>()

function hashString(str: string): number {
  let h = 5381
  for (let i = 0; i < str.length; i++) h = (h * 33) ^ str.charCodeAt(i)
  return h >>> 0
}

/** Build a Telegram-safe (<=64 bytes) callback_data and register its mapping. */
function callbackDataKey(action: string): string {
  if (new TextEncoder().encode(action).byteLength <= 64) return action
  let key = `act:${hashString(action).toString(36)}`
  while (actionByData.has(key) && actionByData.get(key) !== action) key += "x"
  actionByData.set(key, action)
  return key
}

/** Resolve the full action behind a (possibly truncated) callback_data. */
function resolveCallbackData(data: string): string {
  return actionByData.get(data) ?? data
}

async function buildIdleKeyboard(client: any, sessionID: string | null): Promise<InlineKeyboard | undefined> {
  return [
    [
      { text: "🛠 Build", callback_data: callbackDataKey("mode:build") },
      { text: "🧠 Plan", callback_data: callbackDataKey("mode:plan") },
    ],
    [
      { text: "🔁 Continue", callback_data: callbackDataKey("continue") },
      { text: "🛑 Abort", callback_data: callbackDataKey("abort") },
    ],
  ]
}

function buildSessionKeyboard(sessions: any[], currentID: string | null): InlineKeyboard {
  const rows: InlineKeyboard = []
  const seen = new Set<string>()
  for (const s of sessions.slice(0, 20)) {
    if (!s?.id || seen.has(s.id)) continue
    seen.add(s.id)
    const label = truncateToWords(s.title || s.id, 5)
    rows.push([
      {
        text: `${s.id === currentID ? "⚡" : "💬"} ${label}`,
        callback_data: callbackDataKey(`session:${s.id}`),
      },
    ])
  }
  rows.push([{ text: "📬 Back to most recent", callback_data: callbackDataKey("session:latest") }])
  return rows
}

function buildPermissionKeyboard(): InlineKeyboard {
  return [
    [
      { text: "✅ Allow once", callback_data: "allow" },
      { text: "✅ Always", callback_data: "always" },
    ],
    [{ text: "🚫 Reject", callback_data: "reject" }],
  ]
}

// ---- Update polling ---------------------------------------------------------

async function pollUpdates(client: any, config: TelegramConfig): Promise<void> {
  const res = await tg(
    config.botToken,
    "getUpdates",
    {
      offset: lastUpdateId,
      timeout: Math.floor(POLL_TIMEOUT_MS / 1000),
      allowed_updates: ["message", "callback_query"],
    },
    POLL_TIMEOUT_MS + 5000
  )
  if (!res || !res.ok || !Array.isArray(res.result)) return

  for (const update of res.result) {
    if (update.update_id <= lastUpdateId) continue
    try {
      if (update.callback_query) {
        await handleCallbackQuery(client, config, update.callback_query)
      } else if (update.message?.text) {
        await handleTextMessage(client, config, String(update.message.chat.id), update.message.text)
      }
    } catch (err: any) {
      client.app.log({
        body: {
          service: BOT_NAME,
          level: "error",
          message: `Failed to handle update ${update.update_id}: ${err?.message ?? err}`,
        },
      })
    }
    lastUpdateId = update.update_id
  }
}

function startUpdateLoop(client: any, config: TelegramConfig): void {
  let inFlight = false
  const tick = async () => {
    if (inFlight) return
    inFlight = true
    try {
      await pollUpdates(client, config)
    } catch {
      // pollUpdates never throws; keep the loop alive regardless
    }
    inFlight = false
    setTimeout(() => tick(), POLL_INTERVAL_MS)
  }
  tick()
}

// ---- Plugin ---------------------------------------------------------------

const plugin: Plugin = async ({ client }) => {
  const config = loadConfig(client)
  if (!config) return {}

  // Validate the token up-front so failures surface at startup instead of
  // silently never notifying.
  const me = await tg(config.botToken, "getMe")
  if (!me || !me.ok) {
    client.app.log({
      body: {
        service: BOT_NAME,
        level: "error",
        message: `getMe failed — invalid bot token? ${me?.description ?? "network error"}`,
      },
    })
    return {}
  }
  client.app.log({
    body: {
      service: BOT_NAME,
      level: "info",
      message: `Connected to Telegram as @${me.result?.username ?? "bot"}`,
    },
  })

  startUpdateLoop(client, config)

  return {
    event: async ({ event }) => {
      // --- session.idle ---
      if (event.type === "session.idle") {
        const { sessionID } = event.properties

        const [title, summary] = await Promise.all([
          getSessionTitle(client, sessionID),
          getLastAssistantText(client, sessionID),
        ])

        // Deduplicate: skip if same summary + same session
        if (summary === lastIdleSummary && sessionID === lastIdleSessionID) {
          return
        }
        lastIdleSummary = summary
        lastIdleSessionID = sessionID
        activeSessionID = sessionID

        const display = truncateToWords(summary)
        const keyboard = await buildIdleKeyboard(client, sessionID)
        const chatNote =
          targetSessionID && targetSessionID !== sessionID
            ? `\n📨 Replies to: ${await getSessionTitle(client, targetSessionID)}`
            : ""
        const text = `🤖 Agent finished [${title}]:\n${display}${chatNote}`

        const previousMessageId = messageIdBySession.get(sessionID)
        if (previousMessageId) {
          await editMessage(config.botToken, config.chatId, previousMessageId, text, keyboard)
        } else {
          const sent = await sendMessage(config.botToken, config.chatId, text, keyboard)
          const messageId = sent?.result?.message_id
          if (typeof messageId === "number") {
            messageIdBySession.set(sessionID, messageId)
            sessionByMessageId.set(messageId, sessionID)
          }
        }
      }

      // --- session.error ---
      if (event.type === "session.error") {
        const { sessionID, error } = event.properties
        const errorMsg = extractErrorMessage(error)
        const title = sessionID ? await getSessionTitle(client, sessionID) : "unknown"
        await sendMessage(
          config.botToken,
          config.chatId,
          `❌ Session error [${title}]:\n${errorMsg}`,
          sessionID ? await buildIdleKeyboard(client, sessionID) : undefined
        )
      }

      // --- permission.updated ---
      if (event.type === "permission.updated") {
        const perm: any = event.properties
        const { id, sessionID, type, pattern, title } = perm
        const patternStr = Array.isArray(pattern) ? pattern.join(", ") : pattern || "(none)"
        const sessionTitle = sessionID ? await getSessionTitle(client, sessionID) : "unknown"
        const sent = await sendMessage(
          config.botToken,
          config.chatId,
          `🔔 Permission needed [${sessionTitle}]:\n${title}\nType: ${type}\nPattern: ${patternStr}`,
          buildPermissionKeyboard()
        )
        const messageId = sent?.result?.message_id
        if (typeof messageId === "number" && id) {
          permissionByMessageId.set(messageId, id)
          sessionByMessageId.set(messageId, sessionID)
        }
      }
    },
  }
}

export default {
  id: "telegram-notify",
  server: plugin,
} satisfies PluginModule