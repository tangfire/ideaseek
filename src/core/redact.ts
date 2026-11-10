/**
 * Display-layer secret redaction (docs: secret 不得进入 prompt、事件、日志、
 * artifact、错误栈). Event summaries and task errors are contractually
 * secret-free; this is defense in depth for anything rendered to a terminal
 * or machine-readable projection.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
    .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1***')
    .replace(/((?:api[_-]?key|token|password|secret|authorization)\s*[=:]\s*)[^\s'"]+/gi, '$1***');
}
