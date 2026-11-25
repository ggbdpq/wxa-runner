/**
 * 用户级会话 Storage 仓库：按 appid 和 profile 存放在 ~/.wxa-runner/storage/<appid>/<profile>.json
 *
 * 与业务仓库完全解耦，不感知具体业务 Storage key；供 DevServer 在 App.onLaunch 之前预注入到 s0 Storage，
 * 也供浏览器一键回写保存和 `wxa-runner session pull` 从微信开发者工具同步。
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import express, { Router } from 'express';
import { createLoopbackGuard } from './devtoolsLogin';

export const DEFAULT_SESSION_PROFILE = 'default';
export const SESSION_DIR_ENV = 'WXA_SESSION_DIR';

export type SessionSource = 'devtools' | 'browser' | 'import';

export interface SessionRecord {
  appid: string;
  profile: string;
  updatedAt: string;
  source: SessionSource;
  storage: Record<string, unknown>;
}

export interface SessionProfileInfo {
  profile: string;
  file: string;
  keys: number;
  updatedAt?: string;
  source?: SessionSource;
}

const VALID_SEGMENT = /^[a-zA-Z0-9._-]{1,80}$/;

function assertSegment(value: string, label: string): string {
  if (!VALID_SEGMENT.test(value) || value === '.' || value === '..') {
    throw new Error(`非法的${label}：${value}`);
  }
  return value;
}

export function sessionRootDir(baseDir?: string): string {
  return baseDir || process.env[SESSION_DIR_ENV] || path.join(os.homedir(), '.wxa-runner', 'storage');
}

export function sessionFilePath(appid: string, profile = DEFAULT_SESSION_PROFILE, baseDir?: string): string {
  return path.join(sessionRootDir(baseDir), assertSegment(appid, 'appid'), `${assertSegment(profile, '会话名')}.json`);
}

export function readSessionStorage(appid: string, profile = DEFAULT_SESSION_PROFILE, baseDir?: string): SessionRecord | null {
  const file = sessionFilePath(appid, profile, baseDir);
  if (!fs.existsSync(file)) return null;
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!isPlainObject(raw)) {
    throw new Error(`会话文件格式不正确：${file}`);
  }
  const storage = isPlainObject(raw.storage) ? raw.storage : raw;
  return {
    appid: typeof raw.appid === 'string' ? raw.appid : appid,
    profile: typeof raw.profile === 'string' ? raw.profile : profile,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
    source: raw.source === 'devtools' || raw.source === 'browser' || raw.source === 'import' ? raw.source : 'import',
    storage
  };
}

export function writeSessionStorage(
  appid: string,
  storage: Record<string, unknown>,
  options: { profile?: string; source?: SessionSource; baseDir?: string } = {}
): { file: string; profile: string; keys: string[] } {
  if (!isPlainObject(storage)) {
    throw new Error('会话 storage 必须是 { key: value } 对象');
  }
  const profile = options.profile || DEFAULT_SESSION_PROFILE;
  const file = sessionFilePath(appid, profile, options.baseDir);
  const record: SessionRecord = {
    appid,
    profile,
    updatedAt: new Date().toISOString(),
    source: options.source || 'import',
    storage
  };
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(record, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  return { file, profile, keys: Object.keys(storage) };
}

export function clearSessionStorage(appid: string, profile = DEFAULT_SESSION_PROFILE, baseDir?: string): boolean {
  const file = sessionFilePath(appid, profile, baseDir);
  if (!fs.existsSync(file)) return false;
  fs.rmSync(file, { force: true });
  return true;
}

export function listSessionProfiles(appid: string, baseDir?: string): SessionProfileInfo[] {
  const dir = path.join(sessionRootDir(baseDir), assertSegment(appid, 'appid'));
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter(name => name.endsWith('.json'))
    .sort()
    .map(name => {
      const profile = name.slice(0, -'.json'.length);
      const file = path.join(dir, name);
      try {
        const record = readSessionStorage(appid, profile, baseDir);
        return {
          profile,
          file,
          keys: record ? Object.keys(record.storage).length : 0,
          updatedAt: record?.updatedAt,
          source: record?.source
        };
      } catch {
        return { profile, file, keys: 0 };
      }
    });
}

/**
 * 挂在 /__wxa__/session 的本机读写接口，严格限制 onlyLoopback 防止局域网泄露会话凭证
 */
export function sessionRouter(appid: string, profile: string, options: { baseDir?: string } = {}): Router {
  const router = express.Router();
  router.use(createLoopbackGuard('会话接口只允许本机访问'));

  router.get('/', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const record = readSessionStorage(appid, profile, options.baseDir);
      res.json({
        profile,
        storage: record?.storage ?? null,
        updatedAt: record?.updatedAt ?? null,
        source: record?.source ?? null
      });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  router.post('/', express.json({ limit: '10mb' }), (req, res) => {
    try {
      const storage = req.body?.storage;
      if (!isPlainObject(storage)) {
        res.status(400).json({ error: '请求体需要包含 storage 对象' });
        return;
      }
      const saved = writeSessionStorage(appid, storage, {
        profile,
        source: 'browser',
        baseDir: options.baseDir
      });
      res.json(saved);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  router.delete('/', (_req, res) => {
    try {
      const cleared = clearSessionStorage(appid, profile, options.baseDir);
      res.json({ profile, cleared });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  return router;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === '[object Object]';
}
