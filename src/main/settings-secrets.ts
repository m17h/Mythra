import { safeStorage } from 'electron';
import type { AppSettings, ProviderKind } from '@shared/types';

/** Prefix for values encrypted with Electron safeStorage (OS keychain). */
export const ENCRYPTED_SECRET_PREFIX = 'mythra-enc:';

const PROVIDER_KINDS: ProviderKind[] = ['lmstudio', 'openrouter', 'ollama'];

export function isEncryptedSecret(value: string): boolean {
  return value.startsWith(ENCRYPTED_SECRET_PREFIX);
}

export function isEncryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

/** Decrypt a stored secret for in-memory use; plaintext legacy values pass through unchanged. */
export function decryptSecretValue(stored: string): string {
  if (!stored) return '';
  if (!isEncryptedSecret(stored)) return stored;
  if (!isEncryptionAvailable()) {
    console.warn('[mythra] Encrypted API key on disk but OS encryption is unavailable on this machine.');
    return '';
  }
  try {
    const encoded = stored.slice(ENCRYPTED_SECRET_PREFIX.length);
    const buffer = Buffer.from(encoded, 'base64');
    return safeStorage.decryptString(buffer);
  } catch (error) {
    console.warn('[mythra] Failed to decrypt stored API key:', error);
    return '';
  }
}

/** Encrypt for disk persistence; empty strings stay empty; falls back to plaintext if OS encryption is unavailable. */
export function encryptSecretValue(plain: string): string {
  if (!plain) return '';
  if (!isEncryptionAvailable()) return plain;
  try {
    const buffer = safeStorage.encryptString(plain);
    return `${ENCRYPTED_SECRET_PREFIX}${buffer.toString('base64')}`;
  } catch (error) {
    console.warn('[mythra] Failed to encrypt API key; storing as plaintext:', error);
    return plain;
  }
}

export function decryptSettingsSecrets(settings: AppSettings): AppSettings {
  const providers = { ...settings.providers };
  for (const kind of PROVIDER_KINDS) {
    providers[kind] = {
      ...providers[kind],
      apiKey: decryptSecretValue(providers[kind].apiKey)
    };
  }
  return {
    ...settings,
    providers,
    search: {
      ...settings.search,
      tavilyApiKey: decryptSecretValue(settings.search.tavilyApiKey),
      braveApiKey: decryptSecretValue(settings.search.braveApiKey)
    }
  };
}

export function encryptSettingsSecrets(settings: AppSettings): AppSettings {
  const providers = { ...settings.providers };
  for (const kind of PROVIDER_KINDS) {
    providers[kind] = {
      ...providers[kind],
      apiKey: encryptSecretValue(providers[kind].apiKey)
    };
  }
  return {
    ...settings,
    providers,
    search: {
      ...settings.search,
      tavilyApiKey: encryptSecretValue(settings.search.tavilyApiKey),
      braveApiKey: encryptSecretValue(settings.search.braveApiKey)
    }
  };
}

function isPlaintextSecret(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0 && !isEncryptedSecret(value);
}

/** True when the on-disk JSON still has at least one non-empty secret that is not encrypted yet. */
export function rawSettingsHasPlaintextSecrets(parsed: Partial<AppSettings> | undefined): boolean {
  if (!parsed) return false;
  for (const kind of PROVIDER_KINDS) {
    if (isPlaintextSecret(parsed.providers?.[kind]?.apiKey)) return true;
  }
  if (isPlaintextSecret(parsed.search?.tavilyApiKey)) return true;
  if (isPlaintextSecret(parsed.search?.braveApiKey)) return true;
  return false;
}
