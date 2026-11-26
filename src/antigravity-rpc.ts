import { Rpc } from "@opencode/plugin/rpc"
import { z } from "zod"

export const AccountViewSchema = z.object({
  id: z.string(),
  label: z.string(),
  enabled: z.boolean(),
  verificationRequired: z.boolean(),
  allowedModels: z.array(z.string()).optional(),
  disabledModels: z.array(z.string()).optional(),
  cachedAvailableModels: z.array(z.string()).optional(),
})

const SnapshotInputSchema = z.object({
  snapshotId: z.string(),
})

const MessageOutputSchema = z.object({
  message: z.string(),
})

export const AntigravityAccountsRpc = Rpc.define({
  id: "antigravity-accounts",
  methods: {
    snapshot: {
      input: z.object({}),
      output: z.object({
        snapshotId: z.string(),
        accounts: z.array(AccountViewSchema),
      }),
    },
    releaseSnapshot: {
      input: SnapshotInputSchema,
      output: z.object({ ok: z.boolean() }),
    },
    list: {
      input: SnapshotInputSchema,
      output: MessageOutputSchema,
    },
    quotas: {
      input: z.object({
        snapshotId: z.string(),
        ids: z.array(z.string()).optional(),
      }),
      output: MessageOutputSchema,
    },
    models: {
      input: z.object({
        snapshotId: z.string(),
        ids: z.array(z.string()).optional(),
        refresh: z.boolean().optional(),
      }),
      output: MessageOutputSchema,
    },
    setModelRules: {
      input: z.object({
        snapshotId: z.string(),
        ids: z.array(z.string()),
        allow: z.array(z.string()).optional(),
        deny: z.array(z.string()).optional(),
        clear: z.boolean().optional(),
      }),
      output: MessageOutputSchema,
    },
    verify: {
      input: z.object({
        snapshotId: z.string(),
        ids: z.array(z.string()).optional(),
      }),
      output: MessageOutputSchema,
    },
    setEnabled: {
      input: z.object({
        snapshotId: z.string(),
        ids: z.array(z.string()),
        enabled: z.boolean(),
      }),
      output: MessageOutputSchema,
    },
    remove: {
      input: z.object({
        snapshotId: z.string(),
        ids: z.array(z.string()),
        confirm: z.boolean(),
      }),
      output: MessageOutputSchema,
    },
    removeAll: {
      input: z.object({
        snapshotId: z.string(),
        confirm: z.boolean(),
      }),
      output: MessageOutputSchema,
    },
    configureModels: {
      input: SnapshotInputSchema,
      output: MessageOutputSchema,
    },
    oauthStart: {
      input: z.object({
        snapshotId: z.string(),
        mode: z.enum(["auto", "manual"]),
        accountId: z.string().optional(),
      }),
      output: z.object({
        attemptId: z.string(),
        url: z.string(),
        listening: z.boolean(),
      }),
    },
    oauthWait: {
      input: z.object({
        attemptId: z.string(),
      }),
      output: z.object({
        status: z.enum(["completed", "listener-failed", "cancelled"]),
        message: z.string().optional(),
      }),
    },
    oauthComplete: {
      input: z.object({
        attemptId: z.string(),
        rawCallback: z.string(),
      }),
      output: MessageOutputSchema,
    },
    oauthCancel: {
      input: z.object({
        attemptId: z.string(),
      }),
      output: z.object({ ok: z.boolean() }),
    },
  },
  events: {},
})
