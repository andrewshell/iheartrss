/**
 * Environment parsing and defaults, validated at boot (plan §9).
 *
 * Fail fast and loudly: a bad value here should stop the process at startup,
 * not surface as a strange 500 three phases later.
 *
 * Only the variables phase 1 actually uses are parsed. The rest of §9's table
 * (DATABASE_PATH, ADMIN_TOKEN, IP_HMAC_KEY_FILE, TRUST_PROXY, the revalidation
 * knobs, …) lands with the phase that first reads it — an unused-but-validated
 * variable is just a way to fail a boot for a feature that does not exist yet.
 */

export function loadConfig(env = process.env) {
  const errors = [];

  const port = parsePort(env.PORT, errors);
  const siteUrl = parseSiteUrl(env.SITE_URL, errors);
  const linkbackHosts = parseLinkbackHosts(env.LINKBACK_HOSTS, errors);

  if (errors.length > 0) {
    throw new Error(
      `Invalid configuration:\n${errors.map((e) => `  - ${e}`).join('\n')}`,
    );
  }

  return Object.freeze({ port, siteUrl, linkbackHosts });
}

function parsePort(raw, errors) {
  if (raw === undefined || raw === '') return 3000;

  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    errors.push(`PORT must be an integer between 1 and 65535, got "${raw}"`);
    return 3000;
  }
  return port;
}

function parseSiteUrl(raw, errors) {
  const value = raw === undefined || raw === '' ? 'https://iheartrss.com' : raw;

  let url;
  try {
    url = new URL(value);
  } catch {
    errors.push(`SITE_URL must be an absolute URL, got "${value}"`);
    return value;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    errors.push(`SITE_URL must be http or https, got "${value}"`);
    return value;
  }

  // Normalised to an origin + trailing slash so every `new URL(path, siteUrl)`
  // in the app behaves the same whether or not the operator typed the slash.
  return `${url.origin}/`;
}

function parseLinkbackHosts(raw, errors) {
  const value =
    raw === undefined || raw === '' ? 'iheartrss.com,www.iheartrss.com' : raw;

  const hosts = value
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);

  if (hosts.length === 0) {
    errors.push('LINKBACK_HOSTS must list at least one host');
    return [];
  }

  return Object.freeze(hosts);
}
