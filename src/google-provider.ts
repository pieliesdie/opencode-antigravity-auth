// A distinct provider entrypoint keeps OpenCode's automatic native-driver
// migration from bypassing Antigravity's custom transport.
export { createGoogleGenerativeAI } from "@ai-sdk/google"
