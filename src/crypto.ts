// 加密、签名、随机串等小工具，全部基于 Workers 自带的 Web Crypto。

const enc = new TextEncoder();
const dec = new TextDecoder();

function toB64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function fromB64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function toB64Url(bytes: Uint8Array): string {
  return toB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64Url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  return fromB64(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(text)));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ENCRYPTION_KEY 可以是任意足够长的随机字符串，用 SHA-256 派生出 AES-256 密钥。
const aesKeys = new Map<string, Promise<CryptoKey>>();
function aesKey(secret: string): Promise<CryptoKey> {
  let key = aesKeys.get(secret);
  if (!key) {
    key = crypto.subtle
      .digest('SHA-256', enc.encode(`julebu-mg:aes:${secret}`))
      .then((raw) => crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']));
    aesKeys.set(secret, key);
  }
  return key;
}

export async function encryptSecret(plain: string, secret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(secret), enc.encode(plain));
  return `v1:${toB64(iv)}:${toB64(new Uint8Array(ct))}`;
}

export async function decryptSecret(stored: string, secret: string): Promise<string> {
  const [version, ivB64, ctB64] = stored.split(':');
  if (version !== 'v1' || !ivB64 || !ctB64) throw new Error('unknown ciphertext format');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(ivB64) }, await aesKey(secret), fromB64(ctB64));
  return dec.decode(pt);
}

// 管理后台登录凭证：base64url(payload).base64url(HMAC)。
// 签名密钥里带上 ADMIN_PASSWORD，改了后台密码，旧凭证全部失效。
function hmacKey(material: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    enc.encode(`julebu-mg:hmac:${material}`),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

export async function signToken(payload: { exp: number } & Record<string, unknown>, material: string): Promise<string> {
  const body = toB64Url(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(material), enc.encode(body));
  return `${body}.${toB64Url(new Uint8Array(sig))}`;
}

export async function verifyToken<T extends { exp: number }>(token: string, material: string): Promise<T | null> {
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  try {
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(material), fromB64Url(sig), enc.encode(body));
    if (!ok) return null;
    const payload = JSON.parse(dec.decode(fromB64Url(body))) as T;
    return payload.exp > Date.now() ? payload : null;
  } catch {
    return null;
  }
}

// 比较前先各自做哈希，长度一致，避免按时间差猜密码。
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const [da, db] = await Promise.all([a, b].map((s) => crypto.subtle.digest('SHA-256', enc.encode(s))));
  return crypto.subtle.timingSafeEqual(da, db);
}

// 分组代码：去掉 0/O、1/I 这类容易看错的字符。32 个字符，取模没有偏差。
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function randomCode(length = 8): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

export function randomToken(): string {
  return toB64Url(crypto.getRandomValues(new Uint8Array(24)));
}
