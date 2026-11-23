const TOOL = "tools.opencode.session_move"
const HINT = "When you create a worktree outside the current working directory and intend to use it as your primary working directory, consider using `execute` to call `tools.opencode.session_move` and make the worktree the session's working directory."

/** Drop only the generated Code Mode declaration and its stock worktree hint. */
function compatibleText(text: string): string {
  if (!text.includes(TOOL)) return text
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? []
  let catalog = false
  let opencode = false
  const kept: string[] = []
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!
    const trimmed = line.trim()
    if (trimmed === HINT) continue
    if (/^#/.test(trimmed)) catalog = trimmed === "## Code Mode tools (call only inside `execute`)"
    if (/^- /.test(line)) opencode = /^- opencode \(/.test(line)
    if (catalog && opencode && trimmed.startsWith(`- ${TOOL}(`)) {
      // Only consume a complete, recognizable declaration, never the next
      // entry or free-form prose following an incomplete declaration.
      let last = -1
      for (let end = index; end < Math.min(lines.length, index + 18); end++) {
        const candidate = lines[end]?.trim() ?? ""
        if (end > index && !/^(?:\/\*\*|sessionID[?:]|directory:|[}>])/.test(candidate)) break
        if (/>\s*\/\/ Move a session to another directory\b/.test(candidate)) {
          last = end
          break
        }
      }
      if (last !== -1) { index = last; continue }
    }
    kept.push(line)
  }
  return kept.join("")
}

export function applySystemCompatibility(request: Record<string, unknown>): void {
  const instruction = request.systemInstruction
  if (typeof instruction === "string") request.systemInstruction = compatibleText(instruction)
  else if (instruction && typeof instruction === "object" && "parts" in instruction && Array.isArray(instruction.parts)) {
    instruction.parts = instruction.parts.flatMap((part: unknown) => {
      if (!part || typeof part !== "object" || !("text" in part) || typeof part.text !== "string") return [part]
      const text = compatibleText(part.text)
      return text === part.text ? [part] : text.trim() ? [{ ...part, text }] : []
    })
  }
}
