export {
  AntigravityCLIOAuthPlugin,
  GoogleOAuthPlugin,
} from "./src/plugin";

export {
  authorizeAntigravity,
  exchangeAntigravity,
} from "./src/antigravity/oauth";

export type {
  AntigravityAuthorization,
  AntigravityTokenExchangeResult,
} from "./src/antigravity/oauth";
import { AntigravityV2Plugin } from "./src/plugin-v2.ts"
import { AntigravityCLIOAuthPlugin } from "./src/plugin.ts"

export default {
  ...AntigravityV2Plugin,
  server: AntigravityCLIOAuthPlugin,
}
