import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { UserRole } from '../src/types.ts';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const RUNTIME_KEY_FILE = path.join(DATA_DIR, '.runtime-secret');

function getConfiguredSecretEnv(): string | undefined {
  const candidate = process.env.NETANYA_SECRET || process.env.APOTHECARY_SECRET;
  return candidate && candidate.length >= 16 ? candidate : undefined;
}

function resolveServerSecret(): string {
  const configured = getConfiguredSecretEnv();
  if (configured) {
    return configured;
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(RUNTIME_KEY_FILE)) {
    const existing = fs.readFileSync(RUNTIME_KEY_FILE, 'utf8').trim();
    if (existing.length >= 32) return existing;
  }
  const generated = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(RUNTIME_KEY_FILE, generated, { mode: 0o600 });
  return generated;
}

const SERVER_SECRET = resolveServerSecret();
const AES_KEY = deriveAesKey(SERVER_SECRET);
const TOKEN_KEY = crypto.createHash('sha256').update(`session-hmac:${SERVER_SECRET}`).digest();

function deriveAesKey(secret: string): Buffer {
  return crypto.createHash('sha256').update(`phi-vault:${secret}`).digest();
}

export function isUsingConfiguredSecret(): boolean {
  return Boolean(getConfiguredSecretEnv());
}

export function getLegacyRuntimeAesKey(): Buffer | null {
  if (!fs.existsSync(RUNTIME_KEY_FILE)) return null;
  const legacy = fs.readFileSync(RUNTIME_KEY_FILE, 'utf8').trim();
  if (!legacy || legacy === SERVER_SECRET) return null;
  return deriveAesKey(legacy);
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const parts = storedHash.split(':');
  if (parts.length !== 2) return false;
  const [salt, keyHex] = parts;
  const expected = Buffer.from(keyHex, 'hex');
  const actual = crypto.scryptSync(password, salt, 64);
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}

export interface SessionPayload {
  uid: string;
  role: UserRole;
  email: string;
  displayName: string;
  exp: number;
}

export function signSessionToken(payload: Omit<SessionPayload, 'exp'>): string {
  const fullPayload: SessionPayload = {
    ...payload,
    exp: Date.now() + 1000 * 60 * 60 * 24 * 7, // 7 days
  };
  const body = Buffer.from(JSON.stringify(fullPayload), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', TOKEN_KEY).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifySessionToken(token: string): SessionPayload | null {
  if (!token || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expectedSig = crypto.createHmac('sha256', TOKEN_KEY).update(body).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SessionPayload;
    if (!parsed.uid || !parsed.role || parsed.exp < Date.now()) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function encryptPHI(data: unknown): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', AES_KEY, iv);
  const plaintext = JSON.stringify(data);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}.${tag.toString('base64')}.${encrypted.toString('base64')}`;
}

export function decryptPHIWithKey<T>(ciphertext: string, key: Buffer): T {
  const parts = ciphertext.split('.');
  if (parts.length !== 3) {
    throw new Error('Malformed encrypted PHI payload');
  }
  const [ivB64, tagB64, dataB64] = parts;
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(ivB64, 'base64')
  );
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ]);
  return JSON.parse(decrypted.toString('utf8')) as T;
}

export function decryptPHI<T>(ciphertext: string): T {
  return decryptPHIWithKey<T>(ciphertext, AES_KEY);
}
