import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

export const CONFIG_ENV = Object.freeze({
  profile: 'KOC_FEISHU_PROFILE', identity: 'KOC_FEISHU_IDENTITY',
  host: 'KOC_FEISHU_HOST', baseToken: 'KOC_FEISHU_BASE_TOKEN',
  tableId: 'KOC_FEISHU_TABLE_ID', accountMarker: 'KOC_BUYIN_ACCOUNT_MARKER',
});
export function configPath(platform = process.platform, env = process.env, home = homedir()) {
  if (platform === 'win32') return join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'KOC Roster Update', 'config.json');
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'KOC Roster Update', 'config.json');
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'koc-roster-update', 'config.json');
}
export function validateConfig(config) {
  const errors = [];
  for (const key of Object.keys(CONFIG_ENV)) {
    if (typeof config[key] !== 'string' || !config[key].trim()) errors.push(`${key} is required`);
    else if (/[\r\n\0]/.test(config[key])) errors.push(`${key} must be a single line`);
  }
  if (config.identity && config.identity !== 'user') errors.push('identity must be user; bot is unsupported by the verified-user write guard');
  if (config.host && !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(config.host)) errors.push('host must be a hostname without https:// or a path');
  return errors;
}
export function readConfig(path = configPath()) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw new Error(`Cannot read configuration: ${error.message}`); }
}
export function configEnvironment(config, env = process.env) {
  const result = { ...env };
  for (const [key, name] of Object.entries(CONFIG_ENV)) if (!result[name] && config[key]) result[name] = config[key];
  return result;
}
export function effectiveConfig(config, env = process.env) {
  return Object.fromEntries(Object.entries(CONFIG_ENV).map(([key, name]) => [key, env[name] || config[key] || '']));
}
