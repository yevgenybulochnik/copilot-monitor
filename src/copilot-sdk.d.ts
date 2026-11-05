/**
 * Types for the part of `@github/copilot-sdk/extension` this extension uses, taken from SDK 1.0.28
 * (bundled with Copilot CLI 1.0.105).
 *
 * The CLI injects the SDK into every extension process at runtime, so it is not a dependency. The
 * real package also pulls in a 170 MB platform runtime, which is a lot to install for types alone.
 */
declare module "@github/copilot-sdk/extension" {
  export interface ToolInvocation {
    sessionId: string
    toolCallId: string
    toolName: string
    arguments: unknown
    /** Set when a sub-agent made the call. */
    agentId?: string
    signal?: AbortSignal
  }

  export type ToolResultType = "success" | "failure" | "rejected" | "denied"

  export interface ToolResultObject {
    textResultForLlm: string
    resultType: ToolResultType
    error?: string
    /** Shown in the timeline instead of the model-facing text. */
    sessionLog?: string
  }

  export interface Tool<TArgs = unknown> {
    name: string
    description?: string
    parameters?: Record<string, unknown>
    handler?: (args: TArgs, invocation: ToolInvocation) => Promise<unknown> | unknown
    /** When true, the tool runs without a permission prompt (deny rules still apply). */
    skipPermission?: boolean
    /** `never` keeps the tool loaded instead of behind tool search. */
    defer?: "auto" | "never"
  }

  export interface CommandContext {
    sessionId: string
    command: string
    commandName: string
    args: string
  }

  export interface CommandDefinition {
    name: string
    description?: string
    handler: (context: CommandContext) => Promise<void> | void
  }

  export interface MessageOptions {
    prompt: string
    /** `system` marks application-generated context rather than something the user typed. */
    source?: "user" | "system" | `agent-${string}`
    /** `enqueue` (default) waits its turn; `immediate` steers into a running turn. */
    mode?: "enqueue" | "immediate"
    /** Shown in the timeline instead of `prompt`. */
    displayPrompt?: string
  }

  export interface SessionEvent {
    id: string
    type: string
    timestamp: string
    agentId?: string
    ephemeral?: boolean
    data: Record<string, unknown>
  }

  export interface SessionUiApi {
    confirm(message: string): Promise<boolean>
    select(message: string, options: string[]): Promise<string | null>
  }

  export interface CopilotSession {
    readonly sessionId: string
    readonly workspacePath: string | undefined
    readonly capabilities: { ui?: { elicitation?: boolean } }
    readonly ui: SessionUiApi
    readonly rpc: {
      metadata: {
        snapshot(): Promise<{ workingDirectory?: string }>
        isProcessing(): Promise<{ processing: boolean }>
      }
    }
    send(options: MessageOptions): Promise<string>
    log(message: string, options?: { level?: "info" | "warning" | "error"; ephemeral?: boolean }): Promise<void>
    on(handler: (event: SessionEvent) => void): () => void
    on(eventType: string, handler: (event: SessionEvent) => void): () => void
  }

  export interface JoinSessionConfig {
    tools?: Tool<any>[]
    commands?: CommandDefinition[]
  }

  export function joinSession(config?: JoinSessionConfig): Promise<CopilotSession>
}
