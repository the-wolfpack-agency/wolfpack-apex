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

/** What each attack tries to do, in words a site owner understands (completes
 *  "an attempt to ..."). Used where the reader is not a security engineer: the
 *  alert emails' "What Forcefield did for you" section. */
export const ATTACK_AIM: Record<string, string> = {
  sql_injection: "trick your database into revealing or changing data",
  nosql_injection: "trick your database into revealing or changing data",
  xss: "plant a harmful script that would run in your visitors' browsers",
  path_traversal: "read private files on your server",
  open_redirect: "use your site's address to send people to a harmful page",
  command_injection: "run its own commands on your server",
  ssti: "run its own code through your page templates",
  template_injection: "run its own code through your page templates",
  log4shell: "take control of the server through its logging",
  crlf_injection: "slip forged headers into your site's responses",
  ssrf: "make your server reach private addresses on its behalf",
  xxe: "read private files through a crafted XML document",
  nextjs_middleware_bypass: "skip your site's security and sign-in checks",
  php_cgi_injection: "run its own code on your server",
  prompt_injection: "hijack an AI assistant that reads your site",
  unrestricted_upload: "upload a harmful file to your server",
  php2shell: "take control of your server",
  react2shell: "take control of your server",
};

export function attackAim(attack: string): string {
  return ATTACK_AIM[attack] ?? "break into your site";
}
