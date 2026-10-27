/**
 * Plain-language names for the attack families the Forcefield engine emits
 * (props.attack, and the alert / digest attack class). ONE map for every place
 * an attack name is shown (the site-analytics board, the journey timeline, the
 * alert and digest emails, the customer dashboard), so a new family is named
 * once. Unknown families fall back to the raw id, de-underscored. Pure; safe in
 * the client bundle.
 */
export const ATTACK_LABEL: Record<string, string> = {
  sql_injection: "SQL injection",
  nosql_injection: "NoSQL injection",
  xss: "cross-site scripting",
  path_traversal: "path traversal",
  open_redirect: "open redirect",
  command_injection: "command injection",
  ssti: "template injection",
  template_injection: "template injection",
  log4shell: "Log4Shell (JNDI lookup)",
  crlf_injection: "header injection (CRLF)",
  ssrf: "server-side request forgery",
  xxe: "XML external entity",
  nextjs_middleware_bypass: "Next.js middleware bypass",
  php_cgi_injection: "PHP-CGI argument injection",
  prompt_injection: "prompt injection",
  unrestricted_upload: "unrestricted file upload",
  // Body-marker remote-code-execution families (body-inspect.ts).
  php2shell: "PHP2Shell, PHP server takeover",
  react2shell: "React2Shell, React/Next.js server takeover",
  honeytoken_trip: "decoy or honeytoken trip",
};

export function attackLabel(attack: string): string {
  return ATTACK_LABEL[attack] ?? attack.replace(/_/g, " ");
}
