// A distinct provider entrypoint keeps OpenCode's automatic native-driver
// migration from bypassing Antigravity's custom transport.
import { createGoogleGenerativeAI as createDriver } from "@ai-sdk/google"
import { withGoogleToolIds } from "./plugin/google-tools.ts"
import type { LanguageModelV3CallOptions } from "@ai-sdk/provider"
import { gemini4Model, gemini4Levels } from "./plugin/gemini4.ts"

export const createGoogleGenerativeAI: typeof createDriver = (options) => {
  const driver = createDriver(options)
  // The pinned driver's validator predates xhigh. Let it serialize everything
  // else, then supply the actual level at the fetch boundary of this call only.
  const xhighDriver = createDriver({ ...options, fetch: (input, init) => {
    const body = JSON.parse(String(init?.body))
    body.generationConfig.thinkingConfig.thinkingLevel = "xhigh"
    return (options?.fetch ?? globalThis.fetch)(input, { ...init, body: JSON.stringify(body) })
  } })
  const chat: typeof driver.chat = (id) => {
    const model = driver.chat(id)
    const generate = model.doGenerate.bind(model)
    const stream = model.doStream.bind(model)
    const family = gemini4Model(id)
    function xhighCall(call: LanguageModelV3CallOptions) {
      const google = call.providerOptions?.google
      const config = google?.thinkingConfig
      if (!family || !gemini4Levels(family.model).includes("xhigh") || !config || typeof config !== "object" ||
          Array.isArray(config) || config.thinkingLevel !== "xhigh") return undefined
      const { thinkingLevel, ...rest } = config
      return { ...call, providerOptions: { ...call.providerOptions, google: { ...google, thinkingConfig: rest } } }
    }
    model.doGenerate = (call) => withGoogleToolIds(call, () => {
      const extended = xhighCall(call)
      return extended ? xhighDriver.chat(id).doGenerate(extended) : generate(call)
    })
    model.doStream = (call) => withGoogleToolIds(call, () => {
      const extended = xhighCall(call)
      return extended ? xhighDriver.chat(id).doStream(extended) : stream(call)
    })
    return model
  }
  return Object.assign(chat, driver, { chat, generativeAI: chat, languageModel: chat })
}
