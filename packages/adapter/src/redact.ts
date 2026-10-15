import { homedir } from "node:os";

const SECRET_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIAL|AUTH|SESSION|COOKIE)/i;

const PATTERNS: RegExp[] = [
  /rr_agent_[A-Za-z0-9_-]{20,}/g,
  /rr_inv_[A-Za-z0-9_-]{16,}/g,
  /sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g,
  /gh[pousr]_[A-Za-z0-9]{30,}/g,
  /github_pat_[A-Za-z0-9_]{30,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /xox[abprs]-[A-Za-z0-9-]{10,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{20,}/g,
];

/**
 * Scrubs text before it leaves this machine: values of secret-looking environment variables, common
 * credential formats, and local absolute paths (replaced by project-relative / ~ forms).
 */
export class Redactor {
  private secrets: string[];
  constructor(
    private projectDir: string,
    env: NodeJS.ProcessEnv = process.env,
  ) {
    this.secrets = Object.entries(env)
      .filter(([k, v]) => SECRET_NAME.test(k) && typeof v === "string" && v.length >= 8)
      .map(([, v]) => v as string)
      .sort((a, b) => b.length - a.length);
  }

  redact(text: string): string {
    let out = text;
    for (const s of this.secrets) out = out.split(s).join("[redacted]");
    for (const re of PATTERNS) out = out.replace(re, "[redacted]");
    out = replacePath(out, this.projectDir, ".");
    const home = homedir();
    if (home && home.length > 3) out = replacePath(out, home, "~");
    return out;
  }
}

function replacePath(text: string, p: string, replacement: string): string {
  const variants = new Set([p, p.replace(/\\/g, "/"), p.replace(/\//g, "\\")]);
  let out = text;
  for (const v of variants) {
    if (!v) continue;
    const re = new RegExp(v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), process.platform === "win32" ? "gi" : "g");
    out = out.replace(re, replacement);
  }
  return out;
}
